import type { Env } from "../env";
import type { Principal } from "../auth/types";
import { ApiError, ErrorCode } from "../utils/responses";
import { logSecurityEvent, SecurityEvent } from "../utils/logging";

export type RateLimitScope = "search" | "read" | "admin";

/**
 * Pre-identity budget for a client that has not authenticated (SR-013).
 * Returns false once exhausted. Callers use it to bound work an anonymous
 * caller can force -- in particular the D1 audit write on every failed
 * authentication, which an attacker could otherwise amplify without limit by
 * replaying malformed tokens.
 *
 * Keyed by `CF-Connecting-IP`, which the Cloudflare edge sets and overwrites
 * on every proxied request, so a client cannot forge it (see
 * docs/SECURITY-ASSUMPTIONS.md A-4).
 */
export async function consumeUnauthenticatedBudget(env: Env, clientKey: string): Promise<boolean> {
  const { success } = await env.RATE_LIMITER_UNAUTH.limit({ key: `unauth:${clientKey}` });
  return success;
}

/**
 * Per-agent, per-scope limits: identity is the rate-limit key,
 * never the caller's IP, since internal agents share egress paths and a
 * compromised agent should be throttled by *who* it is, not where the
 * request came from.
 */
export async function enforceRateLimit(env: Env, principal: Principal, scope: RateLimitScope): Promise<void> {
  const binding = scope === "search" ? env.RATE_LIMITER_SEARCH : scope === "admin" ? env.RATE_LIMITER_ADMIN : env.RATE_LIMITER_READ;
  const { success } = await binding.limit({ key: `${scope}:${principal.agentId}` });
  if (!success) {
    logSecurityEvent(SecurityEvent.RATE_LIMIT, { agent_id: principal.agentId, scope });
    throw new ApiError(ErrorCode.RATE_LIMITED, "Rate limit exceeded, try again shortly.");
  }
}
