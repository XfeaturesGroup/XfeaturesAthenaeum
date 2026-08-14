import { authenticateHttpRequest } from "../../../auth/authenticate";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { assertCanAccessDocument, assertCanReclassifyDocument } from "../../../auth/resource-guard";
import { auditChange } from "../../../audit/audit";
import { validateUploadCandidate } from "../../../ingestion/validation";
import { enforceRateLimit } from "../../../security/rate-limit";
import { enforceQuota } from "../../../security/quota";
import { ApiError, ErrorCode, jsonResponse } from "../../../utils/responses";
import { readJsonBody, readMultipartUpload } from "../../http";
import {
  createDocumentMetadataSchema,
  reviewDecisionRequestSchema,
  rollbackRequestSchema,
  transitionDocumentStatusSchema,
  listDocumentsQuerySchema
} from "../../schemas/admin";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

export async function handleCreateDocumentDraft(request: Request, ctx: RouteContext): Promise<Response> {
  const { file, metadata } = await readMultipartUpload(request, createDocumentMetadataSchema);
  validateUploadCandidate({ filename: file.filename, mimeType: file.mimeType, size: file.bytes.byteLength });
  const services = buildServices(ctx.env);

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.documents" } },
    resource: { type: "document", id: metadata.slug },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "uploads");
      // May only file a document under a domain/classification it could read back.
      assertCanAccessDocument(principal, metadata.domain, metadata.classification);

      const created = await services.documents.createDraft(
        principal,
        {
          slug: metadata.slug,
          title: metadata.title,
          domain: metadata.domain,
          category: metadata.category,
          classification: metadata.classification,
          language: metadata.language,
          content: file.bytes,
          contentType: file.mimeType,
          sourceType: metadata.source_type,
          sourceReference: metadata.source_reference
        },
        principal.agentId
      );

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.documents.create_draft",
        principal,
        resource: { type: "document", id: created.id },
        newValue: { slug: created.slug, domain: created.domain, classification: created.classification }
      });
      return created;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, document }, 201);
}

export async function handleTransitionDocumentStatus(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const body = await readJsonBody(request, transitionDocumentStatusSchema);
  const services = buildServices(ctx.env);

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: body.status === "active" ? "documents.publish" : "admin.documents" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const before = await services.documentsRepo.getById(documentId);
      if (!before) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
      assertCanAccessDocument(principal, before.domain, before.classification);

      const updated = await services.documents.transitionStatus(principal, documentId, body.status, principal.agentId);

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.documents.transition_status",
        principal,
        resource: { type: "document", id: documentId },
        oldValue: { status: before.status },
        newValue: { status: updated.status }
      });
      return updated;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, document });
}

/** Hand a draft off to the durable publish-approval Workflow instead of publishing directly. */
export async function handleSubmitForReview(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "documents.write" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const result = await services.documents.submitForReview(principal, documentId, principal.agentId);

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.documents.submit_for_review",
        principal,
        resource: { type: "document", id: documentId },
        newValue: { workflow_instance_id: result.workflowInstanceId }
      });
      return { document_id: result.documentId, workflow_instance_id: result.workflowInstanceId };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, submission: result }, 202);
}

/**
 * A reviewer's approve/reject decision, delivered to the waiting
 * Workflow instance. Approving publishes the document, so this requires the
 * same `documents.publish` permission as a direct publish -- an approver
 * cannot be a weaker identity than a publisher (SR-001).
 */
export async function handleReviewDecision(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const body = await readJsonBody(request, reviewDecisionRequestSchema);
  const services = buildServices(ctx.env);

  const result = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "documents.publish" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const document = await services.documentsRepo.getById(documentId);
      if (!document) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
      assertCanAccessDocument(principal, document.domain, document.classification);

      let instance;
      try {
        instance = await ctx.env.PUBLISH_WORKFLOW.get(documentId);
      } catch {
        throw new ApiError(ErrorCode.NOT_FOUND, "No pending review for this document.");
      }

      await instance.sendEvent({
        type: "document-review-decision",
        payload: { approved: body.approved, reviewerAgentId: principal.agentId, note: body.note }
      });

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.documents.review_decision",
        principal,
        resource: { type: "document", id: documentId },
        newValue: { approved: body.approved }
      });
      return { document_id: documentId, approved: body.approved };
    }
  });

  return jsonResponse({ request_id: ctx.requestId, decision: result });
}

/** Restore a prior version's bytes as the new current version. */
export async function handleRollbackDocument(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const body = await readJsonBody(request, rollbackRequestSchema);
  const services = buildServices(ctx.env);

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.documents" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const before = await services.documentsRepo.getById(documentId);
      if (!before) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
      assertCanAccessDocument(principal, before.domain, before.classification);

      // Rolling back restores the TARGET version's classification, so this is
      // a reclassification whenever the two differ. Routed through the shared
      // guard (the same one the facts path uses) rather than an inline pair,
      // so the "must hold both the current and the target tier" rule lives in
      // exactly one place -- otherwise the helper drifts out of use and the
      // rule quietly becomes whatever each call site remembered.
      const target = await services.documentsRepo.getVersion(documentId, body.version);
      if (!target) throw new ApiError(ErrorCode.NOT_FOUND, "Document version not found.");
      assertCanReclassifyDocument(principal, before.domain, before.classification, target.classification);

      const rolledBack = await services.documents.rollback(principal, documentId, body.version, principal.agentId);

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.documents.rollback",
        principal,
        resource: { type: "document", id: documentId },
        oldValue: { version: before.version, classification: before.classification },
        newValue: { version: rolledBack.version, classification: rolledBack.classification, rolled_back_to: body.version }
      });
      return rolledBack;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, document });
}

/**
 * Administrative listing for the HQ control plane.
 *
 * Authorization is enforced twice, deliberately: `admin.documents` to reach the
 * listing at all, and then per-row `documents.read` inside the service, so a
 * document above the caller's classification never appears even as a title.
 */
export async function handleListDocuments(request: Request, ctx: RouteContext): Promise<Response> {
  const url = new URL(request.url);
  const query = listDocumentsQuerySchema.parse({
    domain: url.searchParams.get("domain") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined
  });
  const services = buildServices(ctx.env);

  const documents = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.documents" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.documents.listDocuments(principal, {
        ...(query.domain ? { domain: query.domain } : {}),
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit,
        offset: query.offset
      });
    }
  });

  // Echoes the resolved page like every other list route. Offset pagination:
  // a page shorter than `limit` is the last page. No total is returned --
  // counting would cost a second full scan per request, and no caller needs it.
  return jsonResponse({ request_id: ctx.requestId, documents, limit: query.limit, offset: query.offset });
}

/**
 * Administrative single-document read, including its stored content.
 *
 * Separate from `GET /v1/documents/:id` because that path only ever exposes
 * ACTIVE documents; an editor needs to open a draft.
 */
export async function handleGetDocumentForAdmin(request: Request, ctx: RouteContext): Promise<Response> {
  const id = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.documents" } },
    resource: { type: "document", id },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.documents.getAdminDocument(principal, id);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, document });
}
