import { assertAuthorized } from "../auth/authorize";
import type { Principal } from "../auth/types";
import type { FeedbackType } from "../db/rows";
import type { FeedbackRepository } from "../repositories/feedback.repository";
import { LIMITS } from "../config";
import { ApiError, ErrorCode } from "../utils/responses";

export interface SubmitFeedbackRequest {
  sourceId: string;
  sourceType?: string;
  type: FeedbackType;
  message?: string;
}

/**
 * Feedback never mutates production knowledge directly -- it
 * only opens a review item (status "open") for a human/admin workflow.
 */
export class FeedbackService {
  constructor(private readonly repo: FeedbackRepository) {}

  async submit(principal: Principal, request: SubmitFeedbackRequest) {
    assertAuthorized(principal, { action: "feedback.submit" });
    if (request.message && request.message.length > LIMITS.FEEDBACK_MESSAGE_MAX_LENGTH) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, "Feedback message is too long.");
    }
    const row = await this.repo.submit({
      sourceId: request.sourceId,
      sourceType: request.sourceType,
      feedbackType: request.type,
      message: request.message,
      submittedByAgentId: principal.agentId
    });
    return { id: row.id, status: row.status };
  }
}
