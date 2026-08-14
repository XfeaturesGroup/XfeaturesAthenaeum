import { authenticateHttpRequest } from "../../auth/authenticate";
import { runAuthenticatedOperation } from "../../auth/pipeline";
import { enforceRateLimit } from "../../security/rate-limit";
import { enforceQuota } from "../../security/quota";
import { jsonResponse } from "../../utils/responses";
import { readJsonBody } from "../http";
import { searchRequestSchema } from "../schemas/search";
import { buildServices } from "../services";
import type { RouteContext } from "../router";

export async function handleSearch(request: Request, ctx: RouteContext): Promise<Response> {
  const body = await readJsonBody(request, searchRequestSchema);
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "knowledge.search" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "search");
      await enforceQuota(ctx.env, principal, "searches");
      return services.search.searchKnowledge(principal, {
        query: body.query,
        domain: body.domain,
        language: body.language,
        limit: body.limit
      });
    }
  });

  return jsonResponse({ request_id: ctx.requestId, ...result });
}
