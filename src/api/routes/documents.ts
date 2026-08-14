import { authenticateHttpRequest } from "../../auth/authenticate";
import { runAuthenticatedOperation } from "../../auth/pipeline";
import { enforceRateLimit } from "../../security/rate-limit";
import { jsonResponse } from "../../utils/responses";
import { buildServices } from "../services";
import type { RouteContext } from "../router";

export async function handleGetDocument(request: Request, ctx: RouteContext): Promise<Response> {
  const idOrSlug = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);
  const wantsContent = ctx.url.searchParams.get("include") === "content";

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    // Deferred: `documents.read` is scoped by the document's domain AND
    // classification, neither of which is known until the row is read.
    // DocumentsService performs the full check before returning any content,
    // and answers NOT_FOUND rather than FORBIDDEN so existence is not
    // disclosed to a caller who may not see the document.
    authorization: { deferred: { auditAction: "documents.read", enforcedBy: "DocumentsService.getDocument*" } },
    resource: { type: "document", id: idOrSlug },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return wantsContent
        ? services.documents.getDocumentContent(principal, idOrSlug)
        : services.documents.getDocumentMetadata(principal, idOrSlug);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, document });
}
