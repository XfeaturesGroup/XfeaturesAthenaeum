import { authenticateHttpRequest } from "../../../auth/authenticate";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { enforceRateLimit } from "../../../security/rate-limit";
import { jsonResponse } from "../../../utils/responses";
import { parseQuery } from "../../http";
import { paginationSchema } from "../../schemas/common";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

export async function handleListAuditEvents(request: Request, ctx: RouteContext): Promise<Response> {
  const { limit, offset } = parseQuery(ctx.url, paginationSchema);
  const services = buildServices(ctx.env);

  const events = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "audit.read" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      return services.auditRepo.list({ limit, offset });
    }
  });

  return jsonResponse({ request_id: ctx.requestId, events, limit, offset });
}
