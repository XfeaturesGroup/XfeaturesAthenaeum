import { z } from "zod";
import { LIMITS } from "../../config";
import { classificationSchema, slugLikeSchema } from "./common";

export const createFactRequestSchema = z.object({
  namespace: slugLikeSchema,
  key: slugLikeSchema,
  value: z.unknown(),
  title: z.string().max(LIMITS.TITLE_MAX_LENGTH).optional(),
  description: z.string().max(LIMITS.DESCRIPTION_MAX_LENGTH).optional(),
  classification: classificationSchema,
  source_id: z.string().optional(),
  valid_from: z.iso.datetime().optional(),
  valid_until: z.iso.datetime().optional()
});

export const updateFactRequestSchema = z.object({
  value: z.unknown().optional(),
  title: z.string().max(LIMITS.TITLE_MAX_LENGTH).optional(),
  description: z.string().max(LIMITS.DESCRIPTION_MAX_LENGTH).optional(),
  classification: classificationSchema.optional(),
  status: z.enum(["active", "deprecated"]).optional(),
  expected_version: z.number().int().min(1).optional()
});

export const createDocumentMetadataSchema = z.object({
  slug: slugLikeSchema,
  title: z.string().min(1).max(LIMITS.TITLE_MAX_LENGTH),
  domain: z.string().min(1).max(50),
  category: z.string().max(100).optional(),
  classification: classificationSchema,
  language: z.string().min(2).max(10),
  source_type: z.string().max(50).optional(),
  source_reference: z.string().max(500).optional()
});

export const transitionDocumentStatusSchema = z.object({
  status: z.enum(["draft", "pending_review", "active", "deprecated", "archived"])
});

export const reviewDecisionRequestSchema = z.object({
  approved: z.boolean(),
  note: z.string().max(LIMITS.DESCRIPTION_MAX_LENGTH).optional()
});

export const rollbackRequestSchema = z.object({
  version: z.number().int().min(1),
  /**
   * The version the operator saw as current when they chose a target. Optional
   * for compatibility with existing callers, but the console always sends it:
   * picking "restore v2" from a list that has since moved on should fail, not
   * quietly roll back over somebody else's work.
   */
  expected_version: z.number().int().min(1).optional()
});

/**
 * Metadata accompanying an edit. `expected_version` is required rather than
 * optional: two editors who loaded the same document must not silently
 * overwrite each other, and the only way to detect that is to make every
 * caller state which version it believes it is editing.
 *
 * `classification` and `domain` are absent by design -- an edit inherits both.
 * Moving a document between tiers goes through the reclassification guard, not
 * through here.
 */
export const createDocumentVersionMetadataSchema = z.object({
  expected_version: z.coerce.number().int().min(1),
  title: z.string().min(1).max(LIMITS.TITLE_MAX_LENGTH).optional(),
  change_note: z.string().max(LIMITS.DESCRIPTION_MAX_LENGTH).optional()
});

export const createAgentRequestSchema = z
  .object({
    agent_key: slugLikeSchema,
    name: z.string().min(1).max(LIMITS.TITLE_MAX_LENGTH),
    description: z.string().max(LIMITS.DESCRIPTION_MAX_LENGTH).optional(),
    environment: z.enum(["development", "staging", "production"]),
    auth_mode: z.enum(["access", "rpc", "account"]),
    roles: z.array(slugLikeSchema).max(20).default([]),
    // Only meaningful (and only accepted -- see the refine below) for
    // auth_mode "account": which Xfeatures Account identity this agent
    // represents. Exactly one of the two must be set, mirroring the D1 CHECK
    // constraint on `agents` -- this schema rejects the bad shape before it
    // ever reaches the database.
    principal_type: z.enum(["USER", "APPLICATION", "SERVICE", "AI_AGENT"]).optional(),
    account_client_id: z.string().min(1).max(128).optional(),
    account_user_id: z.string().min(1).max(128).optional()
  })
  .refine((v) => v.auth_mode !== "account" || (v.account_client_id !== undefined) !== (v.account_user_id !== undefined), {
    message: 'auth_mode "account" requires exactly one of account_client_id or account_user_id.'
  })
  .refine((v) => v.auth_mode === "account" || (v.account_client_id === undefined && v.account_user_id === undefined), {
    message: "account_client_id / account_user_id only apply to auth_mode \"account\"."
  });

export const setAgentStatusSchema = z.object({
  status: z.enum(["active", "disabled", "revoked"])
});

export const roleAssignmentSchema = z.object({
  role: slugLikeSchema
});

/**
 * `null` explicitly clears a limit (no cap on that dimension); an omitted
 * field leaves the existing value untouched. The route handler
 * (`handleSetAgentQuota`) resolves that distinction against the current row
 * before calling `QuotaRepository.setQuota`, which always writes a fully
 * resolved triple.
 */
export const setAgentQuotaSchema = z.object({
  max_searches_per_day: z.number().int().min(0).nullable().optional(),
  max_writes_per_day: z.number().int().min(0).nullable().optional(),
  max_uploads_per_day: z.number().int().min(0).nullable().optional()
});

/**
 * Query for the administrative document listing. Limits are clamped server-side
 * so a caller cannot ask for an unbounded page.
 */
export const listDocumentsQuerySchema = z.object({
  domain: slugLikeSchema.optional(),
  status: z.enum(["draft", "pending_review", "active", "deprecated", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGINATION_MAX).default(LIMITS.PAGINATION_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0)
});

/**
 * Query for the ingestion listing. Filtering happens in SQL rather than in the
 * client: an operator looking for what failed should not have to pull a page
 * of successes to find it.
 */
export const listIngestionQuerySchema = z.object({
  status: z.enum(["queued", "processing", "completed", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGINATION_MAX).default(LIMITS.PAGINATION_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0)
});

/**
 * Query for the audit listing. `decision` is the filter that matters most --
 * refusals are the reason anyone opens this view -- and it is an enum rather
 * than free text so a typo narrows to nothing visibly instead of silently
 * returning an unfiltered page.
 */
export const listAuditQuerySchema = z.object({
  actor_agent_id: z.string().min(1).max(100).optional(),
  action: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._-]+$/, "Must be alphanumeric with . _ - only.")
    .optional(),
  decision: z.enum(["ALLOW", "DENY", "N/A"]).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGINATION_MAX).default(LIMITS.PAGINATION_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0)
});

/**
 * Query for the administrative fact listing. `namespace` narrows within what
 * the caller may already read -- it can never widen it, which the service
 * enforces against the principal's own namespace scope rather than trusting
 * this parameter.
 */
export const listFactsQuerySchema = z.object({
  namespace: slugLikeSchema.optional(),
  status: z.enum(["active", "deprecated"]).optional(),
  q: z.string().max(LIMITS.QUERY_MAX_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGINATION_MAX).default(LIMITS.PAGINATION_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0)
});
