import { z } from "zod";
import { LIMITS, SEARCH_DOMAINS, SUPPORTED_LANGUAGES } from "../../config";

export const classificationSchema = z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]);
export const searchDomainSchema = z.enum(SEARCH_DOMAINS);
export const languageSchema = z.enum(SUPPORTED_LANGUAGES);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGINATION_MAX).default(LIMITS.PAGINATION_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0)
});

/** Safe identifier: what we accept for path segments (agent keys, codes, slugs, namespaces). */
export const slugLikeSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Must be alphanumeric with . _ - only.");
