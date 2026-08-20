import { LIMITS } from "../config";
import { StaleVersionError } from "../db/errors";
import type { DocumentRow, DocumentStatus, DocumentVersionRow } from "../db/rows";
import type { Classification } from "../security/classification";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface CreateDocumentInput {
  /** Caller-supplied id (so the R2 key built before the row exists matches the row's actual id). Falls back to a generated id. */
  id?: string;
  slug: string;
  title: string;
  r2Key: string;
  domain: string;
  category?: string;
  classification: Classification;
  language: string;
  contentHash: string;
  sourceType?: string;
  sourceReference?: string;
  validFrom?: string;
  validUntil?: string;
  createdBy: string;
}

export interface ListDocumentsOptions {
  domain?: string;
  status?: DocumentStatus;
  classifications?: readonly Classification[];
  limit: number;
  offset: number;
}

export interface NewDocumentVersionInput {
  r2Key: string;
  title?: string;
  classification?: Classification;
  contentHash: string;
  changeNote?: string;
  updatedBy: string;
  expectedVersion?: number;
}

export class DocumentsRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<DocumentRow | null> {
    const row = await this.db.prepare("SELECT * FROM documents WHERE id = ?1").bind(id).first<DocumentRow>();
    return row ?? null;
  }

  async getBySlug(slug: string): Promise<DocumentRow | null> {
    const row = await this.db.prepare("SELECT * FROM documents WHERE slug = ?1").bind(slug).first<DocumentRow>();
    return row ?? null;
  }

  /**
   * Batched live lookup used by SearchService as a defense-in-depth check
   * against a stale search index: a document that was archived
   * or reclassified after it was last indexed must not be served just
   * because the index hasn't caught up yet.
   */
  async getManyByIds(ids: readonly string[]): Promise<DocumentRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await this.db
      .prepare(`SELECT * FROM documents WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<DocumentRow>();
    return results;
  }

  async findByContentHash(contentHash: string): Promise<DocumentRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM documents WHERE content_hash = ?1 LIMIT 1")
      .bind(contentHash)
      .first<DocumentRow>();
    return row ?? null;
  }

  async list(options: ListDocumentsOptions): Promise<DocumentRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.domain) {
      conditions.push(`domain = ?${params.length + 1}`);
      params.push(options.domain);
    }
    if (options.status) {
      conditions.push(`status = ?${params.length + 1}`);
      params.push(options.status);
    }
    // A caller asking for "documents" is not asking for deleted ones. The trash
    // is a separate listing (listTrashed), never a value of this filter -- a
    // trashed document is stored as `archived`, so filtering by status alone
    // would quietly include it.
    conditions.push("trashed_at IS NULL");
    if (options.classifications && options.classifications.length > 0) {
      const placeholders = options.classifications.map((_, i) => `?${params.length + 1 + i}`).join(",");
      conditions.push(`classification IN (${placeholders})`);
      params.push(...options.classifications);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(options.limit, options.offset);
    const { results } = await this.db
      .prepare(
        `SELECT * FROM documents ${where} ORDER BY updated_at DESC LIMIT ?${params.length - 1} OFFSET ?${params.length}`
      )
      .bind(...params)
      .all<DocumentRow>();
    return results;
  }

  async create(input: CreateDocumentInput): Promise<DocumentRow> {
    const id = input.id ?? generateId();
    const now = nowIso();
    const row: DocumentRow = {
      id,
      slug: input.slug,
      title: input.title,
      r2_key: input.r2Key,
      domain: input.domain,
      category: input.category ?? null,
      classification: input.classification,
      language: input.language,
      status: "draft",
      version: 1,
      content_hash: input.contentHash,
      source_type: input.sourceType ?? null,
      source_reference: input.sourceReference ?? null,
      valid_from: input.validFrom ?? null,
      valid_until: input.validUntil ?? null,
      // A new document is not in the trash, and the table's CHECK requires both
      // columns to be absent whenever the status is not `trashed`.
      trashed_at: null,
      status_before_trash: null,
      created_at: now,
      updated_at: now,
      created_by: input.createdBy,
      updated_by: input.createdBy
    };

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO documents
             (id, slug, title, r2_key, domain, category, classification, language, status, version, content_hash,
              source_type, source_reference, valid_from, valid_until, created_at, updated_at, created_by, updated_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
        )
        .bind(
          row.id,
          row.slug,
          row.title,
          row.r2_key,
          row.domain,
          row.category,
          row.classification,
          row.language,
          row.status,
          row.version,
          row.content_hash,
          row.source_type,
          row.source_reference,
          row.valid_from,
          row.valid_until,
          row.created_at,
          row.updated_at,
          row.created_by,
          row.updated_by
        ),
      this.db
        .prepare(
          `INSERT INTO document_versions
             (id, document_id, version, r2_key, title, classification, language, status, content_hash, change_note, created_at, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        )
        .bind(
          generateId(),
          row.id,
          row.version,
          row.r2_key,
          row.title,
          row.classification,
          row.language,
          row.status,
          row.content_hash,
          "initial version",
          row.created_at,
          row.created_by
        )
    ]);

    return row;
  }

  async createNewVersion(documentId: string, input: NewDocumentVersionInput): Promise<DocumentRow> {
    const current = await this.getById(documentId);
    if (!current) {
      throw new Error(`Document not found: ${documentId}`);
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new StaleVersionError(`document:${documentId}`, input.expectedVersion, current.version);
    }

    const now = nowIso();
    const next: DocumentRow = {
      ...current,
      version: current.version + 1,
      r2_key: input.r2Key,
      title: input.title ?? current.title,
      classification: input.classification ?? current.classification,
      content_hash: input.contentHash,
      updated_at: now,
      updated_by: input.updatedBy
    };

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE documents SET version = ?1, r2_key = ?2, title = ?3, classification = ?4, content_hash = ?5, updated_at = ?6, updated_by = ?7
           WHERE id = ?8`
        )
        .bind(next.version, next.r2_key, next.title, next.classification, next.content_hash, next.updated_at, next.updated_by, documentId),
      this.db
        .prepare(
          `INSERT INTO document_versions
             (id, document_id, version, r2_key, title, classification, language, status, content_hash, change_note, created_at, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        )
        .bind(
          generateId(),
          documentId,
          next.version,
          next.r2_key,
          next.title,
          next.classification,
          next.language,
          next.status,
          next.content_hash,
          input.changeNote ?? null,
          next.updated_at,
          input.updatedBy
        )
    ]);

    return next;
  }

  /**
   * Lifecycle transition: draft -> pending_review -> active ->
   * deprecated -> archived. The caller (knowledge service layer) is
   * responsible for enforcing which transitions are legal for which role --
   * this method only persists the new status.
   */
  /**
   * Ordinary lifecycle transitions.
   *
   * Refuses to touch a document that is in the trash: it has a pending deletion
   * and a recorded state to return to, and a bare status update would silently
   * discard one or both. Trash is entered and left through moveToTrash and
   * restoreFromTrash, which maintain those columns together.
   */
  async setStatus(id: string, status: DocumentStatus, updatedBy: string): Promise<void> {
    const result = await this.db
      .prepare("UPDATE documents SET status = ?1, updated_at = ?2, updated_by = ?3 WHERE id = ?4 AND trashed_at IS NULL")
      .bind(status, nowIso(), updatedBy, id)
      .run();
    if (result.meta.changes === 0) {
      const existing = await this.getById(id);
      if (existing?.trashed_at) {
        throw new Error("This document is in the trash. Restore it before changing its status.");
      }
    }
  }

  /**
   * Moves a document to the trash, recording when and what to come back to.
   *
   * `status_before_trash = status` reads the row's existing value -- every
   * assignment in a SQL UPDATE is evaluated against the pre-update row -- so
   * this captures the state being left behind in the same statement that
   * leaves it, with no window where the two disagree.
   *
   * The `status <> 'trashed'` guard makes a second call a no-op rather than
   * resetting the retention window, so trashing something twice cannot extend
   * how long it survives.
   */
  async moveToTrash(id: string, updatedBy: string): Promise<DocumentRow | null> {
    const now = nowIso();
    // `status_before_trash = status` reads the row's existing value: every
    // assignment in a SQL UPDATE evaluates against the pre-update row. So the
    // state being left behind is captured in the same statement that leaves it,
    // with no window where the two disagree.
    //
    // `archived` is not a euphemism here -- it is the terminal state no read
    // path returns, which is what makes the document unavailable immediately.
    // `trashed_at` is what distinguishes "archived" from "archived and going".
    const row = await this.db
      .prepare(
        `UPDATE documents
            SET status_before_trash = status, status = 'archived',
                trashed_at = ?1, updated_at = ?1, updated_by = ?2
          WHERE id = ?3 AND trashed_at IS NULL
        RETURNING *`
      )
      .bind(now, updatedBy, id)
      .first<DocumentRow>();
    return row ?? null;
  }

  /** Returns a trashed document to the exact state it was in before. */
  async restoreFromTrash(id: string, updatedBy: string): Promise<DocumentRow | null> {
    const row = await this.db
      .prepare(
        `UPDATE documents
            SET status = COALESCE(status_before_trash, status), status_before_trash = NULL, trashed_at = NULL,
                updated_at = ?1, updated_by = ?2
          WHERE id = ?3 AND trashed_at IS NOT NULL
        RETURNING *`
      )
      .bind(nowIso(), updatedBy, id)
      .first<DocumentRow>();
    return row ?? null;
  }

  /** The trash, bounded by the caller's readable classifications. */
  async listTrashed(options: { classifications: readonly string[]; limit: number; offset: number }): Promise<DocumentRow[]> {
    const placeholders = options.classifications.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await this.db
      .prepare(
        `SELECT * FROM documents
          WHERE trashed_at IS NOT NULL AND classification IN (${placeholders})
          ORDER BY trashed_at DESC
          LIMIT ?${options.classifications.length + 1} OFFSET ?${options.classifications.length + 2}`
      )
      .bind(...options.classifications, options.limit, options.offset)
      .all<DocumentRow>();
    return results;
  }

  /**
   * Trashed documents whose retention window has closed.
   *
   * Bounded per run: a purge that tries to clear an unbounded backlog in one
   * scheduled invocation is a purge that times out and clears nothing.
   */
  async findPurgeable(cutoffIso: string, limit: number): Promise<DocumentRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM documents
          WHERE trashed_at IS NOT NULL AND trashed_at <= ?1
          ORDER BY trashed_at ASC LIMIT ?2`
      )
      .bind(cutoffIso, limit)
      .all<DocumentRow>();
    return results;
  }

  /** Every R2 key this document has ever occupied, current version included. */
  async allR2Keys(documentId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r2_key FROM document_versions WHERE document_id = ?1
         UNION
         SELECT r2_key FROM documents WHERE id = ?1`
      )
      .bind(documentId)
      .all<{ r2_key: string }>();
    return results.map((r) => r.r2_key);
  }

  /**
   * Removes a purged document's operational records.
   *
   * `document_versions` disappears with it (ON DELETE CASCADE). The other two
   * references have no cascade and would otherwise abort the delete:
   * `ingestion_jobs` rows are operational and go; `policies.document_id` is
   * detached rather than deleted, because a policy is a separate piece of
   * knowledge that merely cited this document -- purging the document is not a
   * reason to destroy the policy.
   *
   * Audit events are untouched. `audit_events.resource_id` is a plain column
   * with no foreign key, so the trail keeps pointing at the id after the row is
   * gone, which is exactly what an audit trail is for. No tombstone is needed
   * to preserve it, and none is written: a tombstone would be a row about a
   * document that was deleted on request.
   */
  async purgeDocument(documentId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE policies SET document_id = NULL WHERE document_id = ?1").bind(documentId),
      this.db.prepare("DELETE FROM ingestion_jobs WHERE document_id = ?1").bind(documentId),
      this.db.prepare("DELETE FROM documents WHERE id = ?1").bind(documentId)
    ]);
  }

  /** Bounded: version history grows without limit over a document's lifetime. */
  async listVersions(documentId: string, limit = LIMITS.PAGINATION_MAX): Promise<DocumentVersionRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM document_versions WHERE document_id = ?1 ORDER BY version DESC LIMIT ?2")
      .bind(documentId, Math.min(limit, LIMITS.PAGINATION_MAX))
      .all<DocumentVersionRow>();
    return results;
  }

  async getVersion(documentId: string, version: number): Promise<DocumentVersionRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM document_versions WHERE document_id = ?1 AND version = ?2")
      .bind(documentId, version)
      .first<DocumentVersionRow>();
    return row ?? null;
  }

  /**
   * (rollback): a target version's bytes are already immutable
   * and still in R2 under their own key -- rollback just points the current
   * row back at that r2_key under a fresh version number. No new R2 write,
   * no history rewritten; document_versions gains one more append-only row.
   */
  async rollbackToVersion(
    documentId: string,
    targetVersion: number,
    updatedBy: string,
    expectedVersion?: number
  ): Promise<DocumentRow> {
    const current = await this.getById(documentId);
    if (!current) throw new Error(`Document not found: ${documentId}`);
    // Same guard as editing: an operator choosing a version from a list they
    // loaded a minute ago must not silently discard whatever landed since.
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new StaleVersionError(`document:${documentId}`, expectedVersion, current.version);
    }
    const target = await this.getVersion(documentId, targetVersion);
    if (!target) throw new Error(`Document version not found: ${documentId} v${String(targetVersion)}`);

    const now = nowIso();
    const next: DocumentRow = {
      ...current,
      version: current.version + 1,
      r2_key: target.r2_key,
      title: target.title,
      classification: target.classification,
      content_hash: target.content_hash,
      updated_at: now,
      updated_by: updatedBy
    };

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE documents SET version = ?1, r2_key = ?2, title = ?3, classification = ?4, content_hash = ?5, updated_at = ?6, updated_by = ?7
           WHERE id = ?8`
        )
        .bind(next.version, next.r2_key, next.title, next.classification, next.content_hash, next.updated_at, next.updated_by, documentId),
      this.db
        .prepare(
          `INSERT INTO document_versions
             (id, document_id, version, r2_key, title, classification, language, status, content_hash, change_note, created_at, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        )
        .bind(
          generateId(),
          documentId,
          next.version,
          next.r2_key,
          next.title,
          next.classification,
          next.language,
          next.status,
          next.content_hash,
          `rollback to v${String(targetVersion)}`,
          next.updated_at,
          updatedBy
        )
    ]);

    return next;
  }
}
