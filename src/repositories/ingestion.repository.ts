import type { IngestionJobRow, IngestionJobStatus, IngestionJobType } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

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
}
