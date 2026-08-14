import { authenticateHttpRequest } from "../../auth/authenticate";
import { runAuthenticatedOperation } from "../../auth/pipeline";
import { enforceRateLimit } from "../../security/rate-limit";
import { jsonResponse } from "../../utils/responses";
import { buildServices } from "../services";
import type { RouteContext } from "../router";

export async function handleGetProduct(request: Request, ctx: RouteContext): Promise<Response> {
  const code = ctx.params["code"] ?? "";
  const services = buildServices(ctx.env);

  const product = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "products.read" } },
    resource: { type: "product", id: code },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.catalog.getProduct(principal, code);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, product });
}

export async function handleGetPlan(request: Request, ctx: RouteContext): Promise<Response> {
  const code = ctx.params["code"] ?? "";
  const services = buildServices(ctx.env);

  const plan = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "prices.read" } },
    resource: { type: "plan", id: code },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.catalog.getPlan(principal, code);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, plan });
}
