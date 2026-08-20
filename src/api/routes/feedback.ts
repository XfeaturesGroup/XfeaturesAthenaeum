import { authenticateHttpRequest } from "../../auth/authenticate";
import { runAuthenticatedOperation } from "../../auth/pipeline";
import { enforceRateLimit } from "../../security/rate-limit";
import { jsonResponse } from "../../utils/responses";
import { readJsonBody } from "../http";
import { feedbackRequestSchema } from "../schemas/search";
import { buildServices } from "../services";
import type { RouteContext } from "../router";

export async function handleSubmitFeedback(request: Request, ctx: RouteContext): Promise<Response> {
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "feedback.submit" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, feedbackRequestSchema);
      return services.feedback.submit(principal, {
        sourceId: body.source_id,
        sourceType: body.source_type,
        type: body.type,
        message: body.message
      });
    }
  });

  return jsonResponse({ request_id: ctx.requestId, feedback: result }, 201);
}
