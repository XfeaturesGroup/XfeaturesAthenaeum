/**
 * Central, documented application-level limits. These are
 * deliberately stricter than what the platform would allow, so a compromised
 * or buggy caller cannot turn one request into unbounded D1/R2/AI Search
 * cost.
 */
export const LIMITS = {
  QUERY_MAX_LENGTH: 2000,
  TITLE_MAX_LENGTH: 300,
  DESCRIPTION_MAX_LENGTH: 4000,
  FILENAME_MAX_LENGTH: 200,
  METADATA_JSON_MAX_BYTES: 16_384,

  SEARCH_RESULTS_DEFAULT: 8,
  SEARCH_RESULTS_MAX: 25,
  SEARCH_MIN_CONFIDENCE_DEFAULT: 0.4,

  /**
   * How long a trashed document can be restored before it is purged.
   *
   * One number, read by the API that reports remaining time, by the purge
   * job that enforces it, and by the tests that pin both -- so "72 hours"
   * cannot come to mean two different things in two places.
   */
  TRASH_RETENTION_HOURS: 72,

  PAGINATION_DEFAULT: 20,
  PAGINATION_MAX: 100,

  BATCH_MAX_ITEMS: 50,

  UPLOAD_MAX_BYTES: 25 * 1024 * 1024,
  REQUEST_JSON_MAX_BYTES: 256 * 1024,

  FEEDBACK_MESSAGE_MAX_LENGTH: 2000
} as const;

// PDF is intentionally not accepted yet: safe text extraction inside a
// Worker (no arbitrary native parser) is a separate piece of work this build
// doesn't claim to have solved (makes PDF support conditional on
// that). Ingest PDFs by converting to Markdown/plain text upstream for now.
export const ALLOWED_UPLOAD_MIME_TYPES = new Set(["text/markdown", "text/plain", "application/json", "text/html"]);

export const ALLOWED_UPLOAD_EXTENSIONS = new Set([".md", ".txt", ".json", ".html", ".htm"]);

export const SEARCH_DOMAINS = [
  "general",
  "support",
  "product",
  "billing",
  "legal",
  "network",
  "infrastructure",
  "security",
  "internal"
] as const;

export type SearchDomain = (typeof SEARCH_DOMAINS)[number];

export const SUPPORTED_LANGUAGES = ["ru", "en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
