import type { Env, IngestionQueueMessage } from "../env";
import { DocumentsRepository } from "../repositories/documents.repository";
import { IngestionRepository } from "../repositories/ingestion.repository";
import { log } from "../utils/logging";

/**
 * (idempotent consumers): document R2 metadata is written
 * synchronously by DocumentsService at draft/version/publish time (Section
 * 44's "store" step), not here -- this job exists to (a) confirm the
 * document is still in the state the job was enqueued for, and (b) record
 * completion/failure for's ingestion_jobs tracking. Re-running the
 * same job twice (at-least-once delivery) just re-confirms the same thing
 * and re-marks it completed; it never creates a duplicate document.
 */
export async function processIngestionJob(message: IngestionQueueMessage, env: Env): Promise<void> {
  const ingestionRepo = new IngestionRepository(env.DB);
  const documentsRepo = new DocumentsRepository(env.DB);

  await ingestionRepo.markProcessing(message.jobId);
  log.info("ingestion_started", { job_id: message.jobId, document_id: message.documentId, job_type: message.jobType });

  const document = await documentsRepo.getById(message.documentId);
  if (!document) {
    await ingestionRepo.markFailed(message.jobId, "DOCUMENT_NOT_FOUND");
    log.error("ingestion_failed", { job_id: message.jobId, document_id: message.documentId, reason: "DOCUMENT_NOT_FOUND" });
    return;
  }

  if (message.jobType === "reindex" && document.status !== "active") {
    // The document moved on (e.g. archived again) before this job ran --
    // nothing to index, not a failure.
    await ingestionRepo.markCompleted(message.jobId);
    return;
  }

  await ingestionRepo.markCompleted(message.jobId);
  log.info("ingestion_completed", { job_id: message.jobId, document_id: message.documentId, job_type: message.jobType });
}

/** A message that exhausted its retries and landed on the dead-letter queue. */
export async function processDeadLetterJob(message: IngestionQueueMessage, env: Env): Promise<void> {
  const ingestionRepo = new IngestionRepository(env.DB);
  await ingestionRepo.markFailed(message.jobId, "MAX_RETRIES_EXCEEDED");
  log.error("ingestion_dead_letter", { job_id: message.jobId, document_id: message.documentId, job_type: message.jobType });
}
