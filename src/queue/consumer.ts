import type { Env, IngestionQueueMessage } from "../env";
import { processDeadLetterJob, processIngestionJob } from "../ingestion/service";
import { log } from "../utils/logging";

/**
 * Single queue handler for both the ingestion queue and its dead-letter
 * queue, branched on `batch.queue`. A message that throws
 * is retried by the platform up to `max_retries` (wrangler.jsonc) before
 * landing on the DLQ automatically.
 */
export async function handleQueueBatch(batch: MessageBatch<IngestionQueueMessage>, env: Env): Promise<void> {
  const isDeadLetter = batch.queue.includes("dlq");

  for (const message of batch.messages) {
    try {
      if (isDeadLetter) {
        await processDeadLetterJob(message.body, env);
      } else {
        await processIngestionJob(message.body, env);
      }
      message.ack();
    } catch {
      log.error("queue_message_failed", { job_id: message.body.jobId, queue: batch.queue });
      message.retry();
    }
  }
}
