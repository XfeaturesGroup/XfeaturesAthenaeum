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
import { LIMITS } from "../config";
import { ApiError, ErrorCode } from "../utils/responses";
import type { Env } from "../env";
import type { DocumentContentDTO, DocumentDTO, DocumentVersionDTO, TrashedDocumentDTO } from "./dto";

function toDTO(row: DocumentRow): DocumentDTO {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    domain: row.domain,
    category: row.category,
    classification: row.classification,
    language: row.language,
    // Stored as `archived` plus a deletion time (migration 0003); reported as
    // `trashed`, because that is what it is to anyone using it.
    status: row.trashed_at !== null ? "trashed" : row.status,
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

/**
 * The trash is absent from this table on purpose. It is entered by moveToTrash
 * and left by restoreFromTrash, which maintain the deletion time and the state
 * to return to. A document in the trash is refused by transitionStatus outright
 * -- otherwise deletion would become a way to republish something that was
 * archived, or to strand a document with a deletion time and nowhere to go
 * back to.
 */
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
    // A document in the trash has a pending deletion and a recorded state to
    // return to. Moving it anywhere else would discard one or both.
    if (current.trashed_at !== null) {
      throw new ApiError(ErrorCode.CONFLICT, "This document is in the trash. Restore it before changing its status.");
    }
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

  /**
   * Edits a document by adding a version, never by rewriting one.
   *
   * The previous version's bytes stay exactly where they were: the new content
   * goes to a new R2 key derived from the new version number, and a
   * `document_versions` row records it. That is what makes rollback possible at
   * all -- there is something to roll back to.
   *
   * `classification` is deliberately not a parameter. The repository layer can
   * change it, and rollback legitimately does so through
   * `assertCanReclassifyDocument`. This path has no such guard because it does
   * not need one: it always inherits the current tier, so editing content can
   * never move a document between classifications.
   * `tests/security/privilege-escalation.test.ts` pins that.
   */
  async createNewVersion(
    principal: Principal,
    documentId: string,
    input: {
      content: ArrayBuffer;
      contentType: string;
      changeNote?: string | undefined;
      title?: string | undefined;
      expectedVersion: number;
    },
    updatedBy: string
  ): Promise<DocumentDTO> {
    assertAuthorized(principal, { action: "documents.write" });
    const current = await this.repo.getById(documentId);
    if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");

    const title = input.title ?? current.title;
    const contentHash = await hashContent(input.content);
    const nextVersion = current.version + 1;
    const r2Key = buildDocumentR2Key(current.classification, current.domain, documentId, nextVersion, input.contentType);
    await this.storage.put(r2Key, input.content, input.contentType, {
      document_id: documentId,
      classification: current.classification,
      domain: current.domain,
      title,
      version: String(nextVersion),
      language: current.language,
      status: current.status,
      updated_at: nowIso()
    });

    try {
      const next = await this.repo.createNewVersion(documentId, {
        r2Key,
        contentHash,
        changeNote: input.changeNote,
        title,
        updatedBy,
        expectedVersion: input.expectedVersion
      });

      // A published document's indexed content is now stale: retrieval would
      // keep answering from the previous version's bytes. Anything not active
      // is not in the index at all, so there is nothing to correct.
      if (next.status === "active") {
        const job = await this.ingestionRepo.create(documentId, "reindex");
        await this.env.INGESTION_QUEUE.send({ jobId: job.id, documentId, jobType: "reindex" });
      }

      return toDTO(next);
    } catch (error) {
      if (error instanceof StaleVersionError) {
        throw new ApiError(ErrorCode.STALE_VERSION, error.message);
      }
      throw error;
    }
  }

  /** Restore a prior version's bytes (already immutable in R2) as the new current version. */
  async rollback(
    principal: Principal,
    documentId: string,
    targetVersion: number,
    updatedBy: string,
    expectedVersion?: number
  ): Promise<DocumentDTO> {
    assertAuthorized(principal, { action: "documents.write" });
    try {
      const next = await this.repo.rollbackToVersion(documentId, targetVersion, updatedBy, expectedVersion);
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

      // Same reason as editing: a published document's indexed content is now
      // the restored version's, and search would otherwise keep answering from
      // the bytes that were just rolled away from.
      if (next.status === "active") {
        const job = await this.ingestionRepo.create(documentId, "reindex");
        await this.env.INGESTION_QUEUE.send({ jobId: job.id, documentId, jobType: "reindex" });
      }

      return toDTO(next);
    } catch (error) {
      if (error instanceof StaleVersionError) {
        throw new ApiError(ErrorCode.STALE_VERSION, error.message);
      }
      throw error;
    }
  }

  /**
   * Moves a document to the trash.
   *
   * Authorized as `documents.publish` rather than `documents.write`: removing
   * something from the knowledge base changes what every consumer of the
   * platform can read, which is the same kind of act as publishing it. A
   * contributor who may draft and revise may not make things disappear.
   *
   * The document stops being retrievable immediately, because every read path
   * filters on status and `trashed` is not `active`. If it was published, the
   * index is corrected too -- otherwise search would keep answering from
   * content that is no longer supposed to exist.
   */
  async moveToTrash(principal: Principal, documentId: string, updatedBy: string): Promise<DocumentDTO> {
    assertAuthorized(principal, { action: "documents.publish" });
    const current = await this.repo.getById(documentId);
    if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
    if (current.trashed_at !== null) {
      throw new ApiError(ErrorCode.CONFLICT, "This document is already in the trash.");
    }

    const trashed = await this.repo.moveToTrash(documentId, updatedBy);
    if (!trashed) throw new ApiError(ErrorCode.CONFLICT, "This document is already in the trash.");

    // Only a published document is in the index; anything else was never there.
    if (current.status === "active") {
      const job = await this.ingestionRepo.create(documentId, "delete");
      await this.env.INGESTION_QUEUE.send({ jobId: job.id, documentId, jobType: "delete" });
    }
    return toDTO(trashed);
  }

  /**
   * Returns a trashed document to the state it was in.
   *
   * Restoring is not publishing: a document that was a draft comes back a
   * draft, and one that was archived comes back archived. The previous state
   * was recorded when it was trashed precisely so that this cannot become a
   * shortcut past review.
   */
  async restoreFromTrash(principal: Principal, documentId: string, updatedBy: string): Promise<DocumentDTO> {
    assertAuthorized(principal, { action: "documents.publish" });
    const current = await this.repo.getById(documentId);
    if (!current) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
    if (current.trashed_at === null) {
      throw new ApiError(ErrorCode.CONFLICT, "This document is not in the trash.");
    }

    const restored = await this.repo.restoreFromTrash(documentId, updatedBy);
    if (!restored) throw new ApiError(ErrorCode.CONFLICT, "This document is not in the trash.");

    // Back in the index only if it returns to being published.
    if (restored.status === "active") {
      const job = await this.ingestionRepo.create(documentId, "reindex");
      await this.env.INGESTION_QUEUE.send({ jobId: job.id, documentId, jobType: "reindex" });
    }
    return toDTO(restored);
  }

  /**
   * The trash, bounded by the caller's own clearance exactly like any other
   * listing -- a document does not become visible to someone new by being
   * deleted.
   */
  async listTrash(principal: Principal, options: { limit: number; offset: number }): Promise<TrashedDocumentDTO[]> {
    assertAuthorized(principal, { action: "admin.documents" });

    const classifications = permittedClassifications(principal);
    if (classifications.length === 0) return [];

    const rows = await this.repo.listTrashed({
      classifications,
      limit: options.limit,
      offset: options.offset
    });

    const now = Date.now();
    return rows
      .filter((row) => authorize(principal, {
        action: "documents.read",
        resource: { domain: row.domain, classification: row.classification }
      }).allowed)
      .map((row) => {
        const trashedAtMs = Date.parse(row.trashed_at ?? "");
        const purgeableAtMs = trashedAtMs + LIMITS.TRASH_RETENTION_HOURS * 3600_000;
        return {
          ...toDTO(row),
          trashedAt: row.trashed_at ?? "",
          statusBeforeTrash: row.status_before_trash ?? "draft",
          purgeableAt: new Date(purgeableAtMs).toISOString(),
          minutesRemaining: Math.max(0, Math.floor((purgeableAtMs - now) / 60_000))
        };
      });
  }

  /**
   * Version history, so an operator choosing what to roll back to can see what
   * they are choosing. Read-authorized like the document itself: history
   * carries titles and classifications, and a caller who may not read the
   * document may not read its past either.
   */
  async listVersions(principal: Principal, documentId: string): Promise<DocumentVersionDTO[]> {
    assertAuthorized(principal, { action: "admin.documents" });
    const row = await this.repo.getById(documentId);
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, "Document not found.");
    assertAuthorizedOrNotFound(
      principal,
      { action: "documents.read", resource: { domain: row.domain, classification: row.classification } },
      "Document not found."
    );

    const versions = await this.repo.listVersions(documentId);
    return versions.map((version) => ({
      version: version.version,
      title: version.title,
      classification: version.classification,
      status: version.status,
      changeNote: version.change_note,
      contentHash: version.content_hash,
      createdAt: version.created_at,
      createdBy: version.created_by,
      isCurrent: version.version === row.version
    }));
  }
}
