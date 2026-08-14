import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { Env, PublishWorkflowParams } from "../env";
import { AuditRepository } from "../repositories/audit.repository";
import { DocumentsRepository } from "../repositories/documents.repository";
import { IngestionRepository } from "../repositories/ingestion.repository";
import { R2DocumentStorage } from "../storage/r2";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

interface ReviewDecisionEvent {
  approved: boolean;
  reviewerAgentId: string;
  note?: string;
}

/**
 * Durable, long-running publish approval: unlike the direct
 * PATCH /v1/admin/documents/:id/status transition (immediate, for callers
 * that already have publish authority), this is the path for content that
 * needs a second human/admin to approve before going live. The instance id
 * is the document id, so the review-decision endpoint can address the
 * running instance without a separate lookup table.
 */
export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishWorkflowParams> {
  override async run(event: WorkflowEvent<PublishWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { documentId, submittedByAgentId } = event.payload;
    const documentsRepo = new DocumentsRepository(this.env.DB);
    const auditRepo = new AuditRepository(this.env.DB);

    await step.do("mark pending review", async () => {
      const document = await documentsRepo.getById(documentId);
      if (!document) throw new Error("Document not found");
      if (document.status !== "pending_review") {
        await documentsRepo.setStatus(documentId, "pending_review", submittedByAgentId);
      }
    });

    const decision = await step.waitForEvent<ReviewDecisionEvent>(`review decision for ${documentId}`, {
      type: "document-review-decision",
      timeout: "7 days"
    });

    await step.do("apply review decision", async () => {
      const nextStatus = decision.payload.approved ? "active" : "draft";
      await documentsRepo.setStatus(documentId, nextStatus, decision.payload.reviewerAgentId);

      if (decision.payload.approved) {
        const document = await documentsRepo.getById(documentId);
        if (document) {
          const storage = new R2DocumentStorage(this.env.DOCS);
          await storage.updateMetadata(document.r2_key, {
            document_id: document.id,
            classification: document.classification,
            domain: document.domain,
            title: document.title,
            version: String(document.version),
            language: document.language,
            status: "active",
            updated_at: nowIso()
          });
          const ingestionRepo = new IngestionRepository(this.env.DB);
          const job = await ingestionRepo.create(documentId, "reindex");
          await this.env.INGESTION_QUEUE.send({ jobId: job.id, documentId, jobType: "reindex" });
        }
      }

      await auditRepo.record({
        requestId: generateId(),
        actorAgentId: decision.payload.reviewerAgentId,
        action: "workflow.publish_review_decision",
        decision: "ALLOW",
        resourceType: "document",
        resourceId: documentId,
        newValue: { approved: decision.payload.approved, note: decision.payload.note ?? null },
        status: "success"
      });
    });
  }
}
