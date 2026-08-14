import { assertAuthorized, assertAuthorizedOrNotFound, authorize, documentDomainScope, permittedClassifications } from "../auth/authorize";
import type { Principal } from "../auth/types";
import type { DocumentRow, DocumentStatus } from "../db/rows";
import { StaleVersionError } from "../db/errors";
import type { DocumentsRepository } from "../repositories/documents.repository";
import type { IngestionRepository } from "../repositories/ingestion.repository";
import { buildDocumentR2Key, type DocumentStorage } from "../storage/r2";
import { hashContent } from "../utils/hash";
import { generateId } from "../utils/ids";
import { isWithinValidityWindow, nowIso } from "../utils/time";
import { ApiError, ErrorCode } from "../utils/responses";
import type { Env } from "../env";
import type { DocumentContentDTO, DocumentDTO } from "./dto";

function toDTO(row: DocumentRow): DocumentDTO {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    domain: row.domain,
    category: row.category,
    classification: row.classification,
    language: row.language,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at,
    sourceReference: row.source_reference
  };
}

export interface CreateDocumentDraftInput {
  slug: string;
  title: string;
  domain: string;
  category?: string;
  classification: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  language: string;
  content: ArrayBuffer;
  contentType: string;
  sourceType?: string;
  sourceReference?: string;
}

const LEGAL_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  draft: ["pending_review", "archived"],
  pending_review: ["draft", "active", "archived"],
  active: ["deprecated", "archived"],
  deprecated: ["active", "archived"],
  archived: []
};

/**
 * Only ACTIVE documents are visible through read paths. Draft /
 * pending_review / deprecated / archived documents exist so the publish
 * workflow (src/workflow/publish-workflow.ts) has something to
 * operate on, but are never returned by getDocument/searchKnowledge.
 */
export class DocumentsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly ingestionRepo: IngestionRepository,
    private readonly storage: DocumentStorage,
    private readonly env: Env
  ) {}

  private async resolveVisible(idOrSlug: string): Promise<DocumentRow | null> {
    const found = (await this.repo.getById(idOrSlug)) ?? (await this.repo.getBySlug(idOrSlug));
    if (!found) return null;
    if (found.status !== "active") return null;
    if (!isWithinValidityWindow(found.valid_from, found.valid_until)) return null;
    return found;
  }

  /**
   * Administrative listing, used by the HQ control plane.
   *
   * Unlike the read paths above this deliberately includes drafts, documents
   * under review and archived documents -- managing them is the point. It is
   * still bounded by the caller's own classification tiers and domains: an
   * administrator who cannot read RESTRICTED never sees a RESTRICTED document
   * in a list, not even its title. Every row is re-checked individually rather
   * than trusting the SQL filter alone.
   */
  async listDocuments(
    principal: Principal,
    options: { domain?: string; status?: DocumentStatus; limit: number; offset: number }
  ): Promise<DocumentDTO[]> {
    assertAuthorized(principal, { action: "admin.documents" });

    const classifications = permittedClassifications(principal);
    if (classifications.length === 0) return [];

    const scope = documentDomainScope(principal);
    if (options.domain) {
      if (scope.kind === "enumerated" && !scope.domains.includes(options.domain)) return [];
    } else if (scope.kind === "enumerated" && scope.domains.length === 0) {
      return [];
    }

    const rows = await this.repo.list({
      ...(options.domain ? { domain: options.domain } : {}),
      ...(options.status ? { status: options.status } : {}),
      classifications,
      limit: options.limit,
      offset: options.offset
    });

    return rows
      .filter((row) => authorize(principal, {
        action: "documents.read",
        resource: { domain: row.domain, classification: row.classification }
      }).allowed)
      .map(toDTO);
  }

  /**
   * Single document for the editor, including drafts and its stored content.
   * `documents.read` is still required for the specific domain/classification,
   * so administrative reach never substitutes for clearance.
   */
  async getAdminDocument(principal: Principal, idOrSlug: string): Promise<DocumentContentDTO> {
    assertAuthorized(principal, { action: "admin.documents" });
    const row = (await this.repo.getById(idOrSlug)) ?? (await this.repo.getBySlug(idOrSlug));
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
    assertAuthorizedOrNotFound(
      principal,
      { action: "documents.read", resource: { domain: row.domain, classification: row.classification } },
      "Document not found."
    );

    const stream = await this.storage.get(row.r2_key);
    const content = stream ? await new Response(stream).text() : "";
    return { ...toDTO(row), content, contentType: "text/plain; charset=utf-8" };
  }

  async getDocumentMetadata(principal: Principal, idOrSlug: string): Promise<DocumentDTO> {
    const row = await this.resolveVisible(idOrSlug);
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
    assertAuthorizedOrNotFound(
      principal,
      { action: "documents.read", resource: { domain: row.domain, classification: row.classification } },
      "Document not found."
    );
    return toDTO(row);
  }

  async getDocumentContent(principal: Principal, idOrSlug: string): Promise<DocumentContentDTO> {
    const row = await this.resolveVisible(idOrSlug);
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
    assertAuthorizedOrNotFound(
      principal,
      { action: "documents.read", resource: { domain: row.domain, classification: row.classification } },
      "Document not found."
    );

    const stream = await this.storage.get(row.r2_key);
    if (!stream) throw new ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Document content is unavailable.");
    const content = await new Response(stream).text();

    return { ...toDTO(row), content, contentType: "text/plain; charset=utf-8" };
  }

  // --- Admin / publish lifecycle -----------------------------------------

  async createDraft(principal: Principal, input: CreateDocumentDraftInput, createdBy: string): Promise<DocumentDTO> {
    assertAuthorized(principal, { action: "documents.write" });
    const existing = await this.repo.getBySlug(input.slug);
    if (existing) throw new ApiError(ErrorCode.CONFLICT, "A document with this slug already exists.");

    const contentHash = await hashContent(input.content);
    const documentId = generateId();
    const r2Key = buildDocumentR2Key(input.classification, input.domain, documentId, 1, input.contentType);
    const now = nowIso();
    await this.storage.put(r2Key, input.content, input.contentType, {
      document_id: documentId,
      classification: input.classification,
      domain: input.domain,
      title: input.title,
      version: "1",
      language: input.language,
      status: "draft",
      updated_at: now
    });

    const row = await this.repo.create({
      id: documentId,
      slug: input.slug,
      title: input.title,
      r2Key,
      domain: input.domain,
      category: input.category,
      classification: input.classification,
      language: input.language,
      contentHash,
      sourceType: input.sourceType,
      sourceReference: input.sourceReference,
      createdBy
    });
    return toDTO(row);
  }

  /**
   * Human-in-the-loop publish: hands a draft to the durable
   * publish-approval Workflow instead of publishing it. Every transport
   * (REST admin route, MCP) calls this same method rather than touching
   * PUBLISH_WORKFLOW directly, so there is exactly one place that decides
   * when a document is eligible for review (parity).
   */
  async submitForReview(
    principal: Principal,
    documentId: string,
    submittedByAgentId: string
  ): Promise<{ documentId: string; workflowInstanceId: string }> {
    assertAuthorized(principal, { action: "documents.write" });
    const document = await this.repo.getById(documentId);
    if (!document) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
    assertAuthorizedOrNotFound(
      principal,
      { action: "documents.read", resource: { domain: document.domain, classification: document.classification } },
      "Document not found."
    );

    if (document.status !== "draft" && document.status !== "pending_review") {
      throw new ApiError(ErrorCode.CONFLICT, `Cannot submit a document in status ${document.status} for review.`);
    }

    const instance = await this.env.PUBLISH_WORKFLOW.create({
      id: documentId,
      params: { documentId, requestedVersion: document.version, submittedByAgentId }
    });

    return { documentId, workflowInstanceId: instance.id };
  }

  async transitionStatus(principal: Principal, documentId: string, nextStatus: DocumentStatus, updatedBy: string): Promise<DocumentDTO> {
    const action = nextStatus === "active" ? "documents.publish" : "documents.write";
    assertAuthorized(principal, { action });

    const current = await this.repo.getById(documentId);
    if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
    if (!LEGAL_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new ApiError(ErrorCode.CONFLICT, `Cannot transition document from ${current.status} to ${nextStatus}.`);
    }

    await this.repo.setStatus(documentId, nextStatus, updatedBy);

    // R2 metadata mirrors D1 status immediately -- best-effort for whatever
    // AI Search reads at its next background reindex. The actual security
    // boundary is the live D1 status check every getDocument/search result
    // goes through regardless of how current the index metadata is
    // (never trust the index alone for a deletion to take effect).
    await this.storage.updateMetadata(current.r2_key, {
      document_id: documentId,
      classification: current.classification,
      domain: current.domain,
      title: current.title,
      version: String(current.version),
      language: current.language,
      status: nextStatus,
      updated_at: nowIso()
    });

    // Publishing (re-)indexes; leaving the active state removes it from the
    // index so search/getDocument agree with each other.
    const jobType = nextStatus === "active" ? "reindex" : "delete";
    const job = await this.ingestionRepo.create(documentId, jobType);
    await this.env.INGESTION_QUEUE.send({ jobId: job.id, documentId, jobType });

    const updated = await this.repo.getById(documentId);
    if (!updated) throw new ApiError(ErrorCode.INTERNAL_ERROR, "Document disappeared after update.");
    return toDTO(updated);
  }

  async createNewVersion(
    principal: Principal,
    documentId: string,
    content: ArrayBuffer,
    contentType: string,
    changeNote: string | undefined,
    updatedBy: string,
    expectedVersion: number
  ): Promise<DocumentDTO> {
    assertAuthorized(principal, { action: "documents.write" });
    const current = await this.repo.getById(documentId);
    if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");

    const contentHash = await hashContent(content);
    const nextVersion = current.version + 1;
    const r2Key = buildDocumentR2Key(current.classification, current.domain, documentId, nextVersion, contentType);
    await this.storage.put(r2Key, content, contentType, {
      document_id: documentId,
      classification: current.classification,
      domain: current.domain,
      title: current.title,
      version: String(nextVersion),
      language: current.language,
      status: current.status,
      updated_at: nowIso()
    });

    try {
      const next = await this.repo.createNewVersion(documentId, {
        r2Key,
        contentHash,
        changeNote,
        updatedBy,
        expectedVersion
      });
      return toDTO(next);
    } catch (error) {
      if (error instanceof StaleVersionError) {
        throw new ApiError(ErrorCode.STALE_VERSION, error.message);
      }
      throw error;
    }
  }

  /** Restore a prior version's bytes (already immutable in R2) as the new current version. */
  async rollback(principal: Principal, documentId: string, targetVersion: number, updatedBy: string): Promise<DocumentDTO> {
    assertAuthorized(principal, { action: "documents.write" });
    const next = await this.repo.rollbackToVersion(documentId, targetVersion, updatedBy);
    await this.storage.updateMetadata(next.r2_key, {
      document_id: next.id,
      classification: next.classification,
      domain: next.domain,
      title: next.title,
      version: String(next.version),
      language: next.language,
      status: next.status,
      updated_at: next.updated_at
    });
    return toDTO(next);
  }
}
