import type { DocumentStatus, IngestionJobRow, IngestionJobStatus, IngestionJobType } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

/** An ingestion job plus the document columns needed to recognise it; document fields are NULL once the document is purged. */
export interface IngestionJobWithDocumentRow extends IngestionJobRow {
  document_title: string | null;
  document_slug: string | null;
  document_status: DocumentStatus | null;
  document_trashed_at: string | null;
}

export class IngestionRepository {
  constructor(private readonly db: D1Database) {}

  async create(documentId: string, jobType: IngestionJobType): Promise<IngestionJobRow> {
    const row: IngestionJobRow = {
      id: generateId(),
      document_id: documentId,
      job_type: jobType,
      status: "queued",
      attempt_count: 0,
      last_error_code: null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await this.db
      .prepare(
        `INSERT INTO ingestion_jobs (id, document_id, job_type, status, attempt_count, last_error_code, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
      )
      .bind(row.id, row.document_id, row.job_type, row.status, row.attempt_count, row.last_error_code, row.created_at, row.updated_at)
      .run();
    return row;
  }

  async getById(id: string): Promise<IngestionJobRow | null> {
    const row = await this.db.prepare("SELECT * FROM ingestion_jobs WHERE id = ?1").bind(id).first<IngestionJobRow>();
    return row ?? null;
  }

  async markProcessing(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE ingestion_jobs SET status = 'processing', attempt_count = attempt_count + 1, updated_at = ?1 WHERE id = ?2")
      .bind(nowIso(), id)
      .run();
  }

  async markCompleted(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE ingestion_jobs SET status = 'completed', updated_at = ?1 WHERE id = ?2")
      .bind(nowIso(), id)
      .run();
  }

  /** `errorCode` must be a short coded reason, never a raw exception message. */
  async markFailed(id: string, errorCode: string): Promise<void> {
    await this.db
      .prepare("UPDATE ingestion_jobs SET status = 'failed', last_error_code = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(errorCode, nowIso(), id)
      .run();
  }

  async list(status: IngestionJobStatus | undefined, limit: number, offset: number): Promise<IngestionJobRow[]> {
    const query = status
      ? this.db.prepare("SELECT * FROM ingestion_jobs WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3").bind(status, limit, offset)
      : this.db.prepare("SELECT * FROM ingestion_jobs ORDER BY created_at DESC LIMIT ?1 OFFSET ?2").bind(limit, offset);
    const { results } = await query.all<IngestionJobRow>();
    return results;
  }

  /**
   * The same page, with just enough of the document attached to recognise the
   * row. A LEFT JOIN, never an inner one: a job outlives the document it
   * indexed (the trash purge removes the document row and keeps the job), and
   * an inner join would erase exactly the history that explains why something
   * disappeared from the index.
   */
  async listWithDocument(
    status: IngestionJobStatus | undefined,
    limit: number,
    offset: number
  ): Promise<IngestionJobWithDocumentRow[]> {
    const columns = `job.id, job.document_id, job.job_type, job.status, job.attempt_count, job.last_error_code,
                     job.created_at, job.updated_at,
                     doc.title AS document_title, doc.slug AS document_slug,
                     doc.status AS document_status, doc.trashed_at AS document_trashed_at`;
    const query = status
      ? this.db
          .prepare(
            `SELECT ${columns} FROM ingestion_jobs job
             LEFT JOIN documents doc ON doc.id = job.document_id
             WHERE job.status = ?1 ORDER BY job.created_at DESC LIMIT ?2 OFFSET ?3`
          )
          .bind(status, limit, offset)
      : this.db
          .prepare(
            `SELECT ${columns} FROM ingestion_jobs job
             LEFT JOIN documents doc ON doc.id = job.document_id
             ORDER BY job.created_at DESC LIMIT ?1 OFFSET ?2`
          )
          .bind(limit, offset);
    const { results } = await query.all<IngestionJobWithDocumentRow>();
    return results;
  }
}
