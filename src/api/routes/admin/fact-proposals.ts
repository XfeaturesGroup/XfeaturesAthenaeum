import { authenticateHttpRequest } from "../../../auth/authenticate";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { auditChange } from "../../../audit/audit";
import { enforceRateLimit } from "../../../security/rate-limit";
import { enforceQuota } from "../../../security/quota";
import { jsonResponse } from "../../../utils/responses";
import { parseQuery, readJsonBody } from "../../http";
import { listFactProposalsQuerySchema, reviewFactProposalSchema } from "../../schemas/admin";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

/**
 * The review queue: facts an agent has asked a human to accept.
 *
 * Reachable with `admin.facts`, and bounded by the reviewer's own clearance --
 * an unreviewed value is not less sensitive than a reviewed one, so the queue
 * is filtered exactly like the facts themselves.
 */
export async function handleListFactProposals(request: Request, ctx: RouteContext): Promise<Response> {
  const query = parseQuery(ctx.url, listFactProposalsQuerySchema);
  const services = buildServices(ctx.env);

  const proposals = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      return services.factProposals.list(principal, {
        status: query.status,
        limit: query.limit,
        offset: query.offset
      });
    }
  });

  return jsonResponse({ request_id: ctx.requestId, proposals, limit: query.limit, offset: query.offset });
}

/**
 * Accept a proposal and write the fact.
 *
 * Gated on `admin.facts` to reach, and on `facts.write` plus the tiers involved
 * inside the service -- against the REVIEWER, never the proposer. This is the
 * only path by which anything an agent proposed becomes something the platform
 * answers.
 */
export async function handleApproveFactProposal(request: Request, ctx: RouteContext): Promise<Response> {
  const proposalId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    resource: { type: "fact_proposal", id: proposalId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const body = await readJsonBody(request, reviewFactProposalSchema);
      const applied = await services.factProposals.approve(principal, proposalId, principal.agentId, body.note);

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.fact_proposals.approve",
        principal,
        resource: { type: "fact", id: `${applied.fact.namespace}/${applied.fact.key}` },
        newValue: {
          proposal_id: proposalId,
          proposed_by: applied.proposal.proposedBy,
          version: applied.fact.version,
          classification: applied.fact.classification
        }
      });
      return applied;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, ...result });
}

/** Decline a proposal. Recorded with the reviewer and their note; nothing is written. */
export async function handleRejectFactProposal(request: Request, ctx: RouteContext): Promise<Response> {
  const proposalId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const proposal = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.facts" } },
    resource: { type: "fact_proposal", id: proposalId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      const body = await readJsonBody(request, reviewFactProposalSchema);
      const rejected = await services.factProposals.reject(principal, proposalId, principal.agentId, body.note);

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.fact_proposals.reject",
        principal,
        resource: { type: "fact", id: `${rejected.namespace}/${rejected.key}` },
        newValue: { proposal_id: proposalId, proposed_by: rejected.proposedBy }
      });
      return rejected;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, proposal });
}
