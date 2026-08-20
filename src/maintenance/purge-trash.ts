import { LIMITS } from "../config";
import { DocumentsRepository } from "../repositories/documents.repository";
import { R2DocumentStorage } from "../storage/r2";
import { auditSystemAction } from "../audit/audit";
import { logSecurityEvent, SecurityEvent } from "../utils/logging";
import { generateId } from "../utils/ids";
import type { Env } from "../env";

/**
 * Permanently removes documents whose trash retention window has closed.
 *
 * This runs on a schedule rather than on a request, because the guarantee is
 * "gone after 72 hours", not "gone the next time somebody opens the console".
 * Nobody can trigger it and nobody can skip it: there is no manual purge
 * anywhere in the product, which is what makes the trash a safety net instead
 * of a slower delete button.
 *
 * Ordering matters and is deliberate:
 *
 *   1. R2 objects first. If the run dies after this, the document is still in
 *      D1 as `trashed` and past its window, so the next run finds it again and
 *      finishes the job. The reverse order would drop the only record of which
 *      objects to delete and orphan them forever.
 *   2. D1 rows second, in one batch.
 *   3. The audit event last, naming what was removed.
 *
 * Every step tolerates having already happened, so a retry is safe and a
 * partial run is simply an incomplete one.
 */

/** How many documents one invocation will clear. */
const PURGE_BATCH = 25;

export interface PurgeOutcome {
  eligible: number;
  purged: string[];
  objectsDeleted: number;
  failures: { documentId: string; reason: string }[];
}

export async function purgeExpiredTrash(env: Env, now: Date = new Date()): Promise<PurgeOutcome> {
  const repo = new DocumentsRepository(env.DB);
  const storage = new R2DocumentStorage(env.DOCS);

  const cutoff = new Date(now.getTime() - LIMITS.TRASH_RETENTION_HOURS * 3600_000).toISOString();
  const eligible = await repo.findPurgeable(cutoff, PURGE_BATCH);

  const outcome: PurgeOutcome = { eligible: eligible.length, purged: [], objectsDeleted: 0, failures: [] };
  if (eligible.length === 0) return outcome;

  for (const doc of eligible) {
    try {
      // Collect every key the document ever occupied BEFORE deleting rows --
      // afterwards there is nothing left to ask.
      const keys = await repo.allR2Keys(doc.id);

      for (const key of keys) {
        // R2 delete is idempotent: removing an already-removed object is not an
        // error, which is what lets a half-finished run be re-run as-is.
        await storage.delete(key);
        outcome.objectsDeleted += 1;
      }

      await repo.purgeDocument(doc.id);
      outcome.purged.push(doc.id);

      // The audit trail outlives the document. `resource_id` carries no foreign
      // key, so this row keeps pointing at an id whose row is gone -- which is
      // the point of an audit trail, and the reason no content tombstone is
      // kept. Nothing here records what the document said.
      await auditSystemAction(env, {
        requestId: `purge-${generateId()}`,
        actor: "scheduled trash purge",
        action: "documents.purge",
        reason: `Retention window of ${String(LIMITS.TRASH_RETENTION_HOURS)}h elapsed`,
        resourceType: "document",
        resourceId: doc.id,
        oldValue: {
          slug: doc.slug,
          domain: doc.domain,
          classification: doc.classification,
          status_before_trash: doc.status_before_trash,
          trashed_at: doc.trashed_at,
          versions_removed: keys.length
        }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome.failures.push({ documentId: doc.id, reason });
      // Left in the trash, still past its window: the next run retries it. A
      // failure that silently marked the document purged would be the one way
      // content could survive a purge while looking deleted.
      logSecurityEvent(SecurityEvent.AUTH_FAILURE, { reason: "TRASH_PURGE_FAILED", document_id: doc.id, detail: reason });
    }
  }

  return outcome;
}
