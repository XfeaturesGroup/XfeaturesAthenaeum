import { authenticateHttpRequest } from "../../../auth/authenticate";
import { assertAuthorized } from "../../../auth/authorize";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { assertCanAccessDocument, assertCanReclassifyDocument } from "../../../auth/resource-guard";
import { auditChange } from "../../../audit/audit";
import { validateUploadCandidate } from "../../../ingestion/validation";
import { enforceRateLimit } from "../../../security/rate-limit";
import { enforceQuota } from "../../../security/quota";
import { LIMITS } from "../../../config";
import { ApiError, ErrorCode, jsonResponse } from "../../../utils/responses";
import { readJsonBody, readMultipartUpload } from "../../http";
import {
  createDocumentMetadataSchema,
  createDocumentVersionMetadataSchema,
  reviewDecisionRequestSchema,
  rollbackRequestSchema,
  transitionDocumentStatusSchema,
  listDocumentsQuerySchema
} from "../../schemas/admin";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

export async function handleCreateDocumentDraft(request: Request, ctx: RouteContext): Promise<Response> {
  const services = buildServices(ctx.env);

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    // `documents.draft`, not `admin.documents` (SR-025): filing a new document
    // is the proposing agent's whole job, while `admin.documents` is the
    // administrative reach that lists and opens everybody else's. A role that
    // needs the first must not have to be given the second.
    authorization: { enforce: { action: "documents.draft" } },
    // No `resource` here: the slug is inside a body this caller has not yet
    // earned the right to have parsed.
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "uploads");
      // Parsed only after the caller is known. Reading the body first meant an
      // anonymous request was parsed and validated before anything checked who
      // sent it, which both spends work on strangers and answers questions
      // they should have to authenticate to ask -- "File extension not
      // allowed: .exe" describes the upload policy to whoever asks.
      const { file, metadata } = await readMultipartUpload(request, createDocumentMetadataSchema);
      validateUploadCandidate({ filename: file.filename, mimeType: file.mimeType, size: file.bytes.byteLength });
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

/**
 * Edits a document by adding a version.
 *
 * Authorized exactly like creating a draft, because it is the same act: new
 * bytes entering the knowledge base under an existing document's identity. It
 * costs an upload against the caller's quota for the same reason.
 *
 * The caller must state the version it edited (`expected_version`); a
 * concurrent edit turns that into STALE_VERSION rather than a silent
 * last-writer-wins overwrite.
 */
export async function handleCreateDocumentVersion(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
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
      await enforceQuota(ctx.env, principal, "uploads");
      // Same ordering as creating a draft: identity first, body second.
      const { file, metadata } = await readMultipartUpload(request, createDocumentVersionMetadataSchema);
      validateUploadCandidate({ filename: file.filename, mimeType: file.mimeType, size: file.bytes.byteLength });

      const before = await services.documentsRepo.getById(documentId);
      if (!before) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
      // Must be able to read the document it is rewriting, in its own tier and
      // domain. No reclassification check is needed here and none would mean
      // anything: an edit inherits the current classification, so the tier the
      // caller is checked against is the only tier involved.
      assertCanAccessDocument(principal, before.domain, before.classification);

      const updated = await services.documents.createNewVersion(
        principal,
        documentId,
        {
          content: file.bytes,
          contentType: file.mimeType,
          changeNote: metadata.change_note,
          title: metadata.title,
          expectedVersion: metadata.expected_version
        },
        principal.agentId
      );

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.documents.create_version",
        principal,
        resource: { type: "document", id: documentId },
        oldValue: { version: before.version, title: before.title },
        newValue: { version: updated.version, title: updated.title, change_note: metadata.change_note ?? null }
      });
      return updated;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, document }, 201);
}

export async function handleTransitionDocumentStatus(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    // Which permission this needs depends on the requested status, which is in
    // the body -- and the body must not be parsed before the caller is known.
    // So the route defers and re-asserts the identical check below, once it has
    // both an authenticated principal and a parsed body.
    authorization: { deferred: { auditAction: "admin.documents.transition", enforcedBy: "handleTransitionDocumentStatus" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, transitionDocumentStatusSchema);
      // The exact check the pipeline used to run, now that `body` exists.
      // DocumentsService.transitionStatus enforces its own action on top of
      // this; both gates are deliberate and neither replaces the other.
      assertAuthorized(principal, { action: body.status === "active" ? "documents.publish" : "admin.documents" });
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
    authorization: { enforce: { action: "documents.draft" } },
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
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, reviewDecisionRequestSchema);
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
      // Parsed only after the caller is known. Reading the body first meant
      // an anonymous request was parsed and validated before anything checked
      // who sent it: it spends work on strangers outside the unauthenticated
      // budget, and it answers questions they should have to authenticate to
      // ask -- a 400 here and a 404 next door maps the admin surface.
      const body = await readJsonBody(request, rollbackRequestSchema);
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

      const rolledBack = await services.documents.rollback(principal, documentId, body.version, principal.agentId, body.expected_version);

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
/**
 * Moves a document to the trash.
 *
 * Gated on `documents.publish`, not `admin.documents`: taking something out of
 * the knowledge base changes what every consumer can read, which is the same
 * kind of authority as putting it in. Drafting and revising stay separate.
 *
 * There is no counterpart that deletes immediately, here or anywhere else. The
 * only thing that removes content permanently is the scheduled purge, and it
 * will not touch anything until the retention window has closed.
 */
export async function handleTrashDocument(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "documents.publish" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");

      const before = await services.documentsRepo.getById(documentId);
      if (!before) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
      assertCanAccessDocument(principal, before.domain, before.classification);

      const trashed = await services.documents.moveToTrash(principal, documentId, principal.agentId);

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.documents.trash",
        principal,
        resource: { type: "document", id: documentId },
        oldValue: { status: before.status },
        newValue: { status: trashed.status, restores_to: before.status }
      });
      return trashed;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, document });
}

/** Returns a trashed document to the exact state it was in before. */
export async function handleRestoreDocument(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const document = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "documents.publish" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");

      const before = await services.documentsRepo.getById(documentId);
      if (!before) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
      assertCanAccessDocument(principal, before.domain, before.classification);

      const restored = await services.documents.restoreFromTrash(principal, documentId, principal.agentId);

      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.documents.restore",
        principal,
        resource: { type: "document", id: documentId },
        oldValue: { status: before.status, was_going_to_be_purged_at: before.trashed_at },
        newValue: { status: restored.status }
      });
      return restored;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, document });
}

/**
 * The trash, with how long each document has left.
 *
 * Bounded by the caller's clearance like any other listing: deleting a document
 * does not make it visible to someone who could not read it.
 */
export async function handleListTrash(request: Request, ctx: RouteContext): Promise<Response> {
  const query = listDocumentsQuerySchema.parse(Object.fromEntries(ctx.url.searchParams));
  const services = buildServices(ctx.env);

  const documents = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.documents" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.documents.listTrash(principal, { limit: query.limit, offset: query.offset });
    }
  });

  return jsonResponse({
    request_id: ctx.requestId,
    documents,
    limit: query.limit,
    offset: query.offset,
    retention_hours: LIMITS.TRASH_RETENTION_HOURS
  });
}

/**
 * A document's version history, so an operator can see what they would be
 * restoring before they restore it. Read-only; the rollback itself is a
 * separate, guarded call.
 */
export async function handleListDocumentVersions(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const versions = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.documents" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "read");
      return services.documents.listVersions(principal, documentId);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, versions });
}

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
