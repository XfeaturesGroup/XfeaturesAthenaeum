import type { ResourceRef } from "../audit/audit";
import { auditAllow, auditDeny, auditError } from "../audit/audit";
import type { Env } from "../env";
import { consumeUnauthenticatedBudget } from "../security/rate-limit";
import { logSecurityEvent, SecurityEvent } from "../utils/logging";
import { ApiError, ErrorCode } from "../utils/responses";
import { assertAuthorized, type AuthzRequest } from "./authorize";
import type { AuthResult, Principal } from "./types";

/**
 * How an operation's authorization is decided.
 *
 * SECURITY-CRITICAL: this field is mandatory precisely because an earlier
 * revision of this file took a free-text `action: string` that was only ever
 * used as an audit label. Eleven admin routes passed `action: "admin.agents"`
 * (and similar), read as authorized, and were in fact reachable by any
 * authenticated principal -- including a public chatbot identity. See
 * docs/SECURITY-REVIEW.md finding SR-001. The type below makes "I forgot to
 * authorize" unrepresentable.
 *
 * - `enforce`: the pipeline calls authorize() itself, BEFORE the handler runs.
 *   This is the default and should be used wherever the permission is knowable
 *   from the request alone.
 * - `deferred`: ONLY for operations whose authorization depends on data that
 *   must be loaded first (e.g. a document's domain and classification are
 *   unknown until its row is read). The named `enforcedBy` function MUST call
 *   assertAuthorized itself. Every deferred call site is enumerated in
 *   docs/SECURITY-REVIEW.md and covered by a regression test asserting the
 *   deferred check actually denies.
 */
export type OperationAuthorization =
  | { enforce: AuthzRequest }
  | { deferred: { auditAction: string; enforcedBy: string } };

export interface OperationParams<T> {
  env: Env;
  requestId: string;
  authorization: OperationAuthorization;
  resource?: ResourceRef;
  /**
   * Pre-identity budget key (client IP for HTTP transports). When present, a
   * failed authentication only writes a D1 audit row while this budget lasts,
   * so an anonymous attacker replaying bad tokens cannot amplify one cheap
   * request into unbounded database writes (SR-013). The security event is
   * always emitted to structured logs regardless.
   */
  clientKey?: string;
  authenticate: () => Promise<AuthResult>;
  handler: (principal: Principal) => Promise<T>;
}

function auditLabel(authorization: OperationAuthorization): string {
  return "enforce" in authorization ? authorization.enforce.action : authorization.deferred.auditAction;
}

/**
 * The one place REST, RPC, and MCP all funnel through:
 * authenticate, authorize, run, audit. A caller that fails either
 * authentication or authorization never reaches the handler, and every
 * outcome is recorded with the same shape regardless of transport.
 */
export async function runAuthenticatedOperation<T>(params: OperationParams<T>): Promise<T> {
  const action = auditLabel(params.authorization);

  const authResult = await params.authenticate();
  if (!authResult.ok) {
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, { request_id: params.requestId, action, reason: authResult.reason });

    const mayAudit = params.clientKey === undefined || (await consumeUnauthenticatedBudget(params.env, params.clientKey));
    if (mayAudit) {
      await auditDeny({
        env: params.env,
        requestId: params.requestId,
        action,
        resource: params.resource,
        principal: null,
        reason: authResult.reason
      });
    }
    throw new ApiError(ErrorCode.UNAUTHENTICATED, "Authentication failed.");
  }

  const { principal } = authResult;
  try {
    if ("enforce" in params.authorization) {
      // Throws FORBIDDEN, which the catch below records as an authorization
      // denial. Runs before the handler, so an unauthorized caller never
      // reaches any repository, queue, or workflow call.
      assertAuthorized(principal, params.authorization.enforce);
    }

    const value = await params.handler(principal);
    await auditAllow({ env: params.env, requestId: params.requestId, action, resource: params.resource, principal });
    return value;
  } catch (error) {
    if (error instanceof ApiError && error.code === ErrorCode.FORBIDDEN) {
      const rawReason = error.details?.["authzReason"];
      const reason = typeof rawReason === "string" ? rawReason : "FORBIDDEN";
      await auditDeny({ env: params.env, requestId: params.requestId, action, resource: params.resource, principal, reason });
    } else {
      const reason = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
      await auditError({ env: params.env, requestId: params.requestId, action, resource: params.resource, principal, reason });
    }
    throw error;
  }
}
