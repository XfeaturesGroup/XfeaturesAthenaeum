import type { Classification } from "../security/classification";
import type { FactProposalRow, FactProposalStatus } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreateFactProposalInput {
  namespace: string;
  key: string;
  valueJson: string;
  title?: string;
  description?: string;
  classification: Classification;
  rationale?: string;
  /** The version the proposer believed was current; NULL for a fact that does not exist yet. */
  basedOnVersion?: number;
  proposedBy: string;
}

export interface ListFactProposalsOptions {
  status?: FactProposalStatus;
  namespaces?: readonly string[];
  classifications: readonly Classification[];
  limit: number;
  offset: number;
}

/** A proposal with the agent key of whoever proposed and whoever reviewed it. */
export interface FactProposalWithActorsRow extends FactProposalRow {
  proposed_by_key: string | null;
  reviewed_by_key: string | null;
}

export class FactProposalsRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateFactProposalInput): Promise<FactProposalRow> {
    const row: FactProposalRow = {
      id: generateId(),
      namespace: input.namespace,
      key: input.key,
      value_json: input.valueJson,
      title: input.title ?? null,
      description: input.description ?? null,
      classification: input.classification,
      rationale: input.rationale ?? null,
      based_on_version: input.basedOnVersion ?? null,
      status: "pending",
      proposed_by: input.proposedBy,
      created_at: nowIso(),
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      resulting_version: null
    };

    await this.db
      .prepare(
        `INSERT INTO fact_proposals
           (id, namespace, key, value_json, title, description, classification, rationale, based_on_version, status, proposed_by, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
      )
      .bind(
        row.id,
        row.namespace,
        row.key,
        row.value_json,
        row.title,
        row.description,
        row.classification,
        row.rationale,
        row.based_on_version,
        row.status,
        row.proposed_by,
        row.created_at
      )
      .run();

    return row;
  }

  async getById(id: string): Promise<FactProposalRow | null> {
    const row = await this.db.prepare("SELECT * FROM fact_proposals WHERE id = ?1").bind(id).first<FactProposalRow>();
    return row ?? null;
  }

  /** How many proposals are still waiting, so a console can show the queue without listing it. */
  async countPending(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS pending FROM fact_proposals WHERE status = 'pending'")
      .first<{ pending: number }>();
    return row?.pending ?? 0;
  }

  /**
   * The queue, bounded by the caller's readable namespaces and tiers.
   *
   * A proposal carries a value that has not been reviewed and may name a
   * classification the caller cannot read -- so it is filtered exactly like the
   * facts themselves. An unreviewed value is not less sensitive than a reviewed
   * one; if anything it is more.
   */
  async list(options: ListFactProposalsOptions): Promise<FactProposalWithActorsRow[]> {
    if (options.classifications.length === 0) return [];
    if (options.namespaces?.length === 0) return [];

    const conditions: string[] = [];
    const params: unknown[] = [];
    const mark = (value: unknown): string => `?${String(params.push(value))}`;

    if (options.status) {
      conditions.push(`proposal.status = ${mark(options.status)}`);
    }
    if (options.namespaces !== undefined) {
      conditions.push(`proposal.namespace IN (${options.namespaces.map(mark).join(",")})`);
    }
    conditions.push(`proposal.classification IN (${options.classifications.map(mark).join(",")})`);

    const limitMark = mark(options.limit);
    const offsetMark = mark(options.offset);

    const { results } = await this.db
      .prepare(
        `SELECT proposal.*, proposer.agent_key AS proposed_by_key, reviewer.agent_key AS reviewed_by_key
           FROM fact_proposals proposal
           LEFT JOIN agents proposer ON proposer.id = proposal.proposed_by
           LEFT JOIN agents reviewer ON reviewer.id = proposal.reviewed_by
          WHERE ${conditions.join(" AND ")}
          ORDER BY CASE proposal.status WHEN 'pending' THEN 0 ELSE 1 END, proposal.created_at DESC
          LIMIT ${limitMark} OFFSET ${offsetMark}`
      )
      .bind(...params)
      .all<FactProposalWithActorsRow>();
    return results;
  }

  /**
   * Records a review decision.
   *
   * Conditional on the proposal still being pending, and reports whether it
   * changed anything: two reviewers opening the same queue must not both get to
   * apply the same proposal, and the loser of that race has to find out from
   * this call rather than from a second fact version appearing.
   */
  async recordDecision(
    id: string,
    decision: Exclude<FactProposalStatus, "pending">,
    reviewedBy: string,
    options: { note?: string; resultingVersion?: number } = {}
  ): Promise<FactProposalRow | null> {
    const row = await this.db
      .prepare(
        `UPDATE fact_proposals
            SET status = ?1, reviewed_by = ?2, reviewed_at = ?3, review_note = ?4, resulting_version = ?5
          WHERE id = ?6 AND status = 'pending'
        RETURNING *`
      )
      .bind(decision, reviewedBy, nowIso(), options.note ?? null, options.resultingVersion ?? null, id)
      .first<FactProposalRow>();
    return row ?? null;
  }
}
