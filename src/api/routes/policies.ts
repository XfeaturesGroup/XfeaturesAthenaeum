import { authenticateHttpRequest } from "../../auth/authenticate";
import { runAuthenticatedOperation } from "../../auth/pipeline";
import { enforceRateLimit } from "../../security/rate-limit";
import { jsonResponse } from "../../utils/responses";
import { buildServices } from "../services";
import type { RouteContext } from "../router";

export async function handleGetPolicy(request: Request, ctx: RouteContext): Promise<Response> {
  const code = ctx.params["code"] ?? "";
  const services = buildServices(ctx.env);

  const policy = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    // Deferred: gated on the policy row's classification once loaded.
    authorization: { deferred: { auditAction: "facts.read", enforcedBy: "PoliciesService.getPolicy" } },
    resource: { type: "policy", id: code },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.policies.getPolicy(principal, code);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, policy });
}
