import type { AgentQuotaRow, QuotaKind } from "../db/rows";
import { nowIso, todayDate } from "../utils/time";

const COLUMN_BY_KIND: Record<QuotaKind, string> = {
  searches: "searches",
  writes: "writes",
  uploads: "uploads"
};

export class QuotaRepository {
  constructor(private readonly db: D1Database) {}

  async getQuota(agentId: string): Promise<AgentQuotaRow | null> {
    const row = await this.db.prepare("SELECT * FROM agent_quotas WHERE agent_id = ?1").bind(agentId).first<AgentQuotaRow>();
    return row ?? null;
  }

  /**
   * Atomically records one unit of `kind` usage for the agent's current UTC
   * day and returns the resulting count -- a single `INSERT ... ON CONFLICT
   *... RETURNING` round trip (/D1 batch atomicity), so two
   * concurrent calls for the same agent/day cannot both read a stale count
   * and both believe they were first. This increments unconditionally, before
   * any quota comparison: enforcement is the caller's job (see
   * `enforceQuota`), and a request that ends up rejected still counted
   * against the day it was attempted on, matching how the platform's own
   * per-minute rate limiters behave.
   */
  async recordUsage(agentId: string, kind: QuotaKind): Promise<number> {
    const column = COLUMN_BY_KIND[kind];
    const date = todayDate();
    const row = await this.db
      .prepare(
        `INSERT INTO agent_usage_daily (agent_id, usage_date, ${column}) VALUES (?1, ?2, 1)
         ON CONFLICT(agent_id, usage_date) DO UPDATE SET ${column} = ${column} + 1
         RETURNING ${column} AS count`
      )
      .bind(agentId, date)
      .first<{ count: number }>();
    // RETURNING on a successful INSERT/UPDATE always yields a row.
    return row?.count ?? 1;
  }

  async setQuota(
    agentId: string,
    limits: { maxSearchesPerDay?: number | null; maxWritesPerDay?: number | null; maxUploadsPerDay?: number | null },
    updatedBy: string
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_quotas (agent_id, max_searches_per_day, max_writes_per_day, max_uploads_per_day, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(agent_id) DO UPDATE SET
           max_searches_per_day = excluded.max_searches_per_day,
           max_writes_per_day = excluded.max_writes_per_day,
           max_uploads_per_day = excluded.max_uploads_per_day,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`
      )
      .bind(agentId, limits.maxSearchesPerDay ?? null, limits.maxWritesPerDay ?? null, limits.maxUploadsPerDay ?? null, nowIso(), updatedBy)
      .run();
  }
}
