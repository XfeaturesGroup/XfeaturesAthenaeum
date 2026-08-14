import { z } from "zod";
import { LIMITS } from "../../config";
import { languageSchema, searchDomainSchema } from "./common";

export const searchRequestSchema = z.object({
  query: z.string().min(1).max(LIMITS.QUERY_MAX_LENGTH),
  domain: searchDomainSchema.optional(),
  language: languageSchema.optional(),
  limit: z.number().int().min(1).max(LIMITS.SEARCH_RESULTS_MAX).optional()
});

export const feedbackRequestSchema = z.object({
  source_id: z.string().min(1).max(200),
  source_type: z.string().min(1).max(50).optional(),
  type: z.enum(["incorrect", "outdated", "missing", "irrelevant", "conflicting"]),
  message: z.string().max(LIMITS.FEEDBACK_MESSAGE_MAX_LENGTH).optional()
});
