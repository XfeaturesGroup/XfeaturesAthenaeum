import { authenticateHttpRequest } from "../../auth/authenticate";
import { runAuthenticatedOperation } from "../../auth/pipeline";
import { enforceRateLimit } from "../../security/rate-limit";
import { jsonResponse } from "../../utils/responses";
import { paginationSchema } from "../schemas/common";
import { parseQuery } from "../http";
import { buildServices } from "../services";
import type { RouteContext } from "../router";

export async function handleGetFact(request: Request, ctx: RouteContext): Promise<Response> {
  const namespace = ctx.params["namespace"] ?? "";
  const key = ctx.params["key"] ?? "";
  const services = buildServices(ctx.env);

  const fact = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    // Deferred: `facts.read` is scoped by BOTH namespace and the row's
    // classification, and the classification is unknown until the row is
    // read. FactsService.getFact performs the full check before returning
    // anything, and answers NOT_FOUND (not FORBIDDEN) so the existence of a
    // fact the caller may not see is never disclosed.
    authorization: { deferred: { auditAction: "facts.read", enforcedBy: "FactsService.getFact" } },
    resource: { type: "fact", id: `${namespace}/${key}` },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.facts.getFact(principal, namespace, key);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, fact });
}

export async function handleListFacts(request: Request, ctx: RouteContext): Promise<Response> {
  const namespace = ctx.params["namespace"] ?? "";
  const { limit, offset } = parseQuery(ctx.url, paginationSchema);
  const services = buildServices(ctx.env);

  const facts = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    // Deferred: each row is filtered individually by classification.
    authorization: { deferred: { auditAction: "facts.read", enforcedBy: "FactsService.getFacts" } },
    resource: { type: "fact_namespace", id: namespace },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.facts.getFacts(principal, namespace, limit, offset);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, facts, limit, offset });
}
