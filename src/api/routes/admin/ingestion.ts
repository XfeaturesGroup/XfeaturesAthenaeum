import { authenticateHttpRequest } from "../../../auth/authenticate";
import { runAuthenticatedOperation } from "../../../auth/pipeline";
import { assertCanAccessDocument } from "../../../auth/resource-guard";
import { auditChange } from "../../../audit/audit";
import { enforceRateLimit } from "../../../security/rate-limit";
import { enforceQuota } from "../../../security/quota";
import { ApiError, ErrorCode, jsonResponse } from "../../../utils/responses";
import { parseQuery } from "../../http";
import { paginationSchema } from "../../schemas/common";
import { buildServices } from "../../services";
import type { RouteContext } from "../../router";

export async function handleListIngestionJobs(request: Request, ctx: RouteContext): Promise<Response> {
  const { limit, offset } = parseQuery(ctx.url, paginationSchema);
  const services = buildServices(ctx.env);

  const jobs = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.ingestion" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      return services.ingestionRepo.list(undefined, limit, offset);
    }
  });

  return jsonResponse({ request_id: ctx.requestId, jobs, limit, offset });
}

/** Controlled reindex of a single document, admin-only. */
export async function handleReindexDocument(request: Request, ctx: RouteContext): Promise<Response> {
  const documentId = ctx.params["id"] ?? "";
  const services = buildServices(ctx.env);

  const job = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.ingestion" } },
    resource: { type: "document", id: documentId },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const document = await services.documentsRepo.getById(documentId);
      if (!document) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
      assertCanAccessDocument(principal, document.domain, document.classification);

      const created = await services.ingestionRepo.create(documentId, "reindex");
      await ctx.env.INGESTION_QUEUE.send({ jobId: created.id, documentId, jobType: "reindex" });
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.ingestion.reindex_document",
        principal,
        resource: { type: "document", id: documentId },
        newValue: { job_id: created.id }
      });
      return created;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, job }, 202);
}

/**
 * Reindex every active document. Bounded (one page
 * of jobs per call) and gated on `admin.ingestion` -- this is the most
 * expensive operation in the system, so an unauthorized caller reaching it
 * would be a direct cost-amplification vector (SR-001).
 */
export async function handleReindexAll(request: Request, ctx: RouteContext): Promise<Response> {
  const services = buildServices(ctx.env);

  const enqueued = await runAuthenticatedOperation({
    env: ctx.env,
    requestId: ctx.requestId,
    clientKey: ctx.clientKey,
    authorization: { enforce: { action: "admin.ingestion" } },
    authenticate: () => authenticateHttpRequest(request, ctx.env),
    handler: async (principal) => {
      await enforceRateLimit(ctx.env, principal, "admin");
      await enforceQuota(ctx.env, principal, "writes");
      const documents = await services.documentsRepo.list({ status: "active", limit: 100, offset: 0 });
      const jobs = [];
      for (const document of documents) {
        const created = await services.ingestionRepo.create(document.id, "reindex");
        await ctx.env.INGESTION_QUEUE.send({ jobId: created.id, documentId: document.id, jobType: "reindex" });
        jobs.push(created.id);
      }
      await auditChange({
        env: ctx.env,
        requestId: ctx.requestId,
        action: "admin.ingestion.reindex_all",
        principal,
        resource: { type: "ingestion", id: "batch" },
        newValue: { job_count: jobs.length }
      });
      return jobs;
    }
  });

  return jsonResponse({ request_id: ctx.requestId, enqueued_job_ids: enqueued }, 202);
}
