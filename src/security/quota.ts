import type { AgentQuotaRow, QuotaKind } from "../db/rows";
import type { Env } from "../env";
import type { Principal } from "../auth/types";
import { QuotaRepository } from "../repositories/quota.repository";
import { ApiError, ErrorCode } from "../utils/responses";
import { logSecurityEvent, SecurityEvent } from "../utils/logging";

function maxFor(quota: AgentQuotaRow, kind: QuotaKind): number | null {
  switch (kind) {
    case "searches":
      return quota.max_searches_per_day;
    case "writes":
      return quota.max_writes_per_day;
    case "uploads":
      return quota.max_uploads_per_day;
  }
}

/**
 * Per-agent, per-day cap (migration 0002's `agent_quotas`/`agent_usage_daily`),
 * separate from and in addition to the per-minute Workers Rate Limiting in
 * `security/rate-limit.ts`. The two answer different questions: the rate
 * limiter bounds how fast an agent can go; this bounds how much it can do in
 * a day at all, which a limiter that only ever looks a few seconds back
 * cannot express.
 *
 * A quota row is opt-in per agent (HQ sets one via `QuotaRepository.setQuota`)
 * -- an agent with no row, or a null column, has no cap on that dimension.
 * There is no daily cap on plain reads (facts/documents/catalog lookups):
 * only `searches`, `writes` and `uploads` have a tracked column at all,
 * on the judgement that semantic search and content mutation are the
 * operations expensive enough to need a hard daily ceiling.
 */
export async function enforceQuota(env: Env, principal: Principal, kind: QuotaKind): Promise<void> {
  const repo = new QuotaRepository(env.DB);
  const quota = await repo.getQuota(principal.agentId);
  const max = quota ? maxFor(quota, kind) : null;

  const count = await repo.recordUsage(principal.agentId, kind);

  if (max !== null && count > max) {
    logSecurityEvent(SecurityEvent.QUOTA_EXCEEDED, { agent_id: principal.agentId, kind, count, max });
    throw new ApiError(ErrorCode.QUOTA_EXCEEDED, `Daily ${kind} quota exceeded.`);
  }
}
