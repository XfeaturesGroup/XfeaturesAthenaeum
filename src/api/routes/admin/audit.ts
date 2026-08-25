import { authenticateHttpRequest } from "../../../auth/authenticate";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { enforceRateLimit } from "../../../security/rate-limit";
import { jsonResponse } from "../../../utils/responses";
import { parseQuery } from "../../http";
import { listAuditQuerySchema } from "../../schemas/admin";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

/**
 * The trail, filtered server-side and projected into the client-facing shape.
 *
 * Answering with the raw D1 row put `actor_identity_raw` -- the unprocessed
 * identity a caller presented -- into every response, and named every other
 * field differently from the rest of this API. `OperationsService` owns both
 * decisions now; see `AuditEventDTO`.
 */
export async function handleListAuditEvents(request: Request, ctx: RouteContext): Promise<Response> {
  const query = parseQuery(ctx.url, listAuditQuerySchema);
  const services = buildServices(ctx.env);

  const events = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "audit.read" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      return services.operations.listAuditEvents({
        actorAgentId: query.actor_agent_id,
        action: query.action,
        decision: query.decision,
        limit: query.limit,
        offset: query.offset
      });
    }
  });

  return jsonResponse({ request_id: ctx.requestId, events, limit: query.limit, offset: query.offset });
}
