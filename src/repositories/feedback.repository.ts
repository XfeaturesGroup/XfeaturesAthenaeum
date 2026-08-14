import type { FeedbackStatus, FeedbackType, KnowledgeFeedbackRow } from "../db/rows";
import { generateId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface SubmitFeedbackInput {
  sourceId: string;
  sourceType?: string;
  feedbackType: FeedbackType;
  message?: string;
  submittedByAgentId: string;
}

export class FeedbackRepository {
  constructor(private readonly db: D1Database) {}

  async submit(input: SubmitFeedbackInput): Promise<KnowledgeFeedbackRow> {
    const row: KnowledgeFeedbackRow = {
      id: generateId(),
      source_id: input.sourceId,
      source_type: input.sourceType ?? null,
      feedback_type: input.feedbackType,
      message: input.message ?? null,
      submitted_by_agent_id: input.submittedByAgentId,
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await this.db
      .prepare(
        `INSERT INTO knowledge_feedback (id, source_id, source_type, feedback_type, message, submitted_by_agent_id, status, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
      )
      .bind(row.id, row.source_id, row.source_type, row.feedback_type, row.message, row.submitted_by_agent_id, row.status, row.created_at, row.updated_at)
      .run();
    return row;
  }

  async list(status: FeedbackStatus | undefined, limit: number, offset: number): Promise<KnowledgeFeedbackRow[]> {
    const query = status
      ? this.db.prepare("SELECT * FROM knowledge_feedback WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3").bind(status, limit, offset)
      : this.db.prepare("SELECT * FROM knowledge_feedback ORDER BY created_at DESC LIMIT ?1 OFFSET ?2").bind(limit, offset);
    const { results } = await query.all<KnowledgeFeedbackRow>();
    return results;
  }

  async setStatus(id: string, status: FeedbackStatus): Promise<void> {
    await this.db
      .prepare("UPDATE knowledge_feedback SET status = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(status, nowIso(), id)
      .run();
  }
}
