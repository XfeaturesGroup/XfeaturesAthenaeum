import { authenticateHttpRequest } from "../../auth/authenticate";
import { runAuthenticatedOperation } from "../../auth/pipeline";
import { jsonResponse } from "../../utils/responses";
import type { RouteContext } from "../router";

/** Public health check. No auth, no dependency detail -- just "the Worker is running". */
// eslint-disable-next-line @typescript-eslint/require-await
export async function handleHealth(_request: Request, ctx: RouteContext): Promise<Response> {
  return jsonResponse({ request_id: ctx.requestId, status: "ok" });
}

/** Protected diagnostics: dependency reachability, admin-only, never on the public /health route. */
export async function handleDependencyHealth(request: Request, ctx: RouteContext): Promise<Response> {
  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.ingestion" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async () => {
      const dependencies: Record<string, "ok" | "error"> = {};

      try {
        await ctx.env.DB.prepare("SELECT 1").first();
        dependencies["d1"] = "ok";
      } catch {
        dependencies["d1"] = "error";
      }

      try {
        await ctx.env.DOCS.head("__health_check__");
        dependencies["r2"] = "ok";
      } catch {
        dependencies["r2"] = "error";
      }

      return dependencies;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, dependencies: result });
}
