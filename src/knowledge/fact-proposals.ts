import { assertAuthorized, authorize, factNamespaceScope, permittedClassifications } from "../auth/authorize";
import { assertCanAccessFact, assertCanReclassifyFact } from "../auth/resource-guard";
import type { Principal } from "../auth/types";
import type { FactProposalRow, FactProposalStatus } from "../db/rows";
import type { FactProposalsRepository, FactProposalWithActorsRow } from "../repositories/fact-proposals.repository";
import type { FactsRepository } from "../repositories/facts.repository";
import type { Classification } from "../security/classification";
import { ApiError, ErrorCode } from "../utils/responses";
import type { FactProposalDTO } from "./dto";
import { toFactDTO } from "./facts";
import type { FactDTO } from "./dto";

export interface ProposeFactInput {
  namespace: string;
  key: string;
  value: unknown;
  title?: string;
  description?: string;
  classification: Classification;
  rationale?: string;
}

function toDTO(row: FactProposalRow & Partial<Pick<FactProposalWithActorsRow, "proposed_by_key" | "reviewed_by_key">>): FactProposalDTO {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    value: JSON.parse(row.value_json) as unknown,
    title: row.title,
    description: row.description,
    classification: row.classification,
    rationale: row.rationale,
    basedOnVersion: row.based_on_version,
    status: row.status,
    proposedBy: row.proposed_by_key ?? row.proposed_by,
    createdAt: row.created_at,
    reviewedBy: row.reviewed_by_key ?? row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    resultingVersion: row.resulting_version
  };
}

/**
 * Facts an agent has asked a human to accept.
 *
 * The rule this service exists to enforce is one sentence long: nothing an
 * agent proposes changes what the platform answers until a person with
 * `facts.write` says so. Everything below is that sentence spelled out.
 *
 * A proposal is a row in its own table, never a fact in a draft state. Every
 * read path in this service filters facts by status, and a proposal sitting one
 * forgotten WHERE clause away from being served would eventually be served; in
 * a separate table it cannot be, whatever anyone forgets.
 *
 * Approval applies the proposal under the REVIEWER's authority. The proposer's
 * permissions are spent entirely at proposal time and are never consulted
 * again -- otherwise an agent could file something into a tier the reviewer
 * cannot read and have the review rubber-stamp it into place.
 */
export class FactProposalsService {
  constructor(
    private readonly proposals: FactProposalsRepository,
    private readonly facts: FactsRepository
  ) {}

  /**
   * File a proposal.
   *
   * `facts.propose` is deliberately not `facts.write`: proposing is asking, and
   * an agent that may ask must not thereby be able to act on another transport
   * with the same credential (SR-025's rule for documents, applied to facts).
   *
   * The proposer must also be able to READ the namespace and tier it is filing
   * into. Without that, an agent could stash a value under a classification it
   * could never see -- which is how content gets laundered into a tier through
   * a proposal queue.
   */
  async propose(principal: Principal, input: ProposeFactInput, proposedBy: string): Promise<FactProposalDTO> {
    assertAuthorized(principal, { action: "facts.propose" });
    assertCanAccessFact(principal, input.namespace, input.classification);

    const existing = await this.facts.getByKey(input.namespace, input.key);
    if (existing) {
      // Proposing a change to a fact the proposer cannot read would let it
      // overwrite a value it was never allowed to see.
      assertCanAccessFact(principal, input.namespace, existing.classification);
    }

    const created = await this.proposals.create({
      namespace: input.namespace,
      key: input.key,
      valueJson: JSON.stringify(input.value ?? null),
      title: input.title,
      description: input.description,
      classification: input.classification,
      rationale: input.rationale,
      basedOnVersion: existing?.version,
      proposedBy
    });

    return toDTO(created);
  }

  /** The review queue, bounded by the caller's own clearance like any other listing. */
  async list(
    principal: Principal,
    options: { status?: FactProposalStatus; limit: number; offset: number }
  ): Promise<FactProposalDTO[]> {
    assertAuthorized(principal, { action: "admin.facts" });

    const classifications = permittedClassifications(principal);
    if (classifications.length === 0) return [];
    const scope = factNamespaceScope(principal);
    if (scope.kind === "enumerated" && scope.namespaces.length === 0) return [];

    const rows = await this.proposals.list({
      status: options.status,
      namespaces: scope.kind === "all" ? undefined : scope.namespaces,
      classifications,
      limit: options.limit,
      offset: options.offset
    });

    return rows
      .filter(
        (row) =>
          authorize(principal, {
            action: "facts.read",
            resource: { namespace: row.namespace, classification: row.classification }
          }).allowed
      )
      .map(toDTO);
  }

  /** How many proposals are waiting, for a console badge. Gated like the queue itself. */
  async countPending(principal: Principal): Promise<number> {
    assertAuthorized(principal, { action: "admin.facts" });
    return this.proposals.countPending();
  }

  /**
   * Accept a proposal and write the fact.
   *
   * Every authorization here is against the reviewer, and the fact is resolved
   * now rather than when it was proposed:
   *
   *   - `facts.write`, because this is the act of changing what the platform
   *     answers. A reviewer who may only read cannot approve.
   *   - The reviewer must hold the tier being written, and -- when the target
   *     already exists -- the tier it currently has, so approving cannot become
   *     a way to reclassify something the reviewer could not reclassify
   *     directly.
   *   - `based_on_version` must still be current. A proposal written against a
   *     price that has since changed is stale, and applying it would silently
   *     undo whoever changed it.
   */
  async approve(principal: Principal, proposalId: string, reviewedBy: string, note?: string): Promise<{ proposal: FactProposalDTO; fact: FactDTO }> {
    assertAuthorized(principal, { action: "facts.write" });

    const proposal = await this.proposals.getById(proposalId);
    // Existence of a proposal the reviewer may not read is not disclosed.
    if (!proposal) throw new ApiError(ErrorCode.NOT_FOUND, "Proposal not found.");
    assertCanAccessFact(principal, proposal.namespace, proposal.classification);
    if (proposal.status !== "pending") {
      throw new ApiError(ErrorCode.CONFLICT, "This proposal has already been reviewed.");
    }

    const current = await this.facts.getByKey(proposal.namespace, proposal.key);

    if (current) {
      assertCanReclassifyFact(principal, proposal.namespace, current.classification, proposal.classification);
      if (proposal.based_on_version !== null && proposal.based_on_version !== current.version) {
        throw new ApiError(
          ErrorCode.STALE_VERSION,
          "The fact has changed since this was proposed. Reject it and ask for a fresh proposal."
        );
      }
      if (current.trashed_at !== null) {
        throw new ApiError(ErrorCode.CONFLICT, "This fact is in the trash. Restore it before applying a proposal to it.");
      }
    } else if (proposal.based_on_version !== null) {
      // It existed when proposed and does not now: something deleted it, and
      // silently recreating it would undo that decision.
      throw new ApiError(ErrorCode.CONFLICT, "The fact this proposal targets no longer exists.");
    }

    // The decision is recorded FIRST, conditionally on the proposal still being
    // pending. Two reviewers who opened the same queue cannot both apply it:
    // the loser gets a conflict here rather than a second fact version.
    const decided = await this.proposals.recordDecision(proposalId, "approved", reviewedBy, { note });
    if (!decided) throw new ApiError(ErrorCode.CONFLICT, "This proposal has already been reviewed.");

    let written;
    try {
      written = current
        ? await this.facts.update(proposal.namespace, proposal.key, {
            valueJson: proposal.value_json,
            title: proposal.title ?? undefined,
            description: proposal.description ?? undefined,
            classification: proposal.classification,
            status: "active",
            updatedBy: reviewedBy,
            expectedVersion: current.version
          })
        : await this.facts.create({
            namespace: proposal.namespace,
            key: proposal.key,
            valueJson: proposal.value_json,
            title: proposal.title ?? undefined,
            description: proposal.description ?? undefined,
            classification: proposal.classification,
            createdBy: reviewedBy
          });
    } catch (error) {
      // The proposal is marked approved but no fact was written. Better to
      // surface that loudly than to leave a queue entry that looks applied:
      // the audit trail records the failure, and the reviewer sees an error
      // rather than a success they did not get.
      throw error instanceof ApiError
        ? error
        : new ApiError(ErrorCode.INTERNAL_ERROR, "The proposal was accepted but the fact could not be written.");
    }

    const finalised = await this.proposals.getById(proposalId);
    return {
      proposal: toDTO({ ...(finalised ?? decided), resulting_version: written.version }),
      fact: toFactDTO(written)
    };
  }

  /**
   * Decline a proposal.
   *
   * Gated on `facts.write` like approval: deciding a proposed value will not be
   * applied is a decision about the knowledge base, and someone who may only
   * read it should not be able to clear the queue.
   */
  async reject(principal: Principal, proposalId: string, reviewedBy: string, note?: string): Promise<FactProposalDTO> {
    assertAuthorized(principal, { action: "facts.write" });

    const proposal = await this.proposals.getById(proposalId);
    if (!proposal) throw new ApiError(ErrorCode.NOT_FOUND, "Proposal not found.");
    assertCanAccessFact(principal, proposal.namespace, proposal.classification);

    const decided = await this.proposals.recordDecision(proposalId, "rejected", reviewedBy, { note });
    if (!decided) throw new ApiError(ErrorCode.CONFLICT, "This proposal has already been reviewed.");
    return toDTO(decided);
  }
}
