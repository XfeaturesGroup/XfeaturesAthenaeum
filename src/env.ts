/**
 * Hand-written Env type mirroring wrangler.jsonc. Normally this project would
 * run `npm run cf-typegen` to generate worker-configuration.d.ts against real
 * bound resources -- this repo ships without a live Cloudflare account
 * attached, so the bindings below are declared by hand and must be kept in
 * sync with wrangler.jsonc until the first `cf-typegen` run against real
 * resource IDs (see README.md "Infrastructure setup").
 */

export interface PublishWorkflowParams {
  documentId: string;
  requestedVersion: number;
  submittedByAgentId: string;
}

export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  AI_SEARCH: AISearch;
  INGESTION_QUEUE: Queue<IngestionQueueMessage>;
  PUBLISH_WORKFLOW: Workflow<PublishWorkflowParams>;

  RATE_LIMITER_SEARCH: RateLimit;
  RATE_LIMITER_READ: RateLimit;
  RATE_LIMITER_ADMIN: RateLimit;
  /** Pre-identity limiter, keyed by client IP. Bounds work an unauthenticated caller can force. */
  RATE_LIMITER_UNAUTH: RateLimit;

  ENVIRONMENT: "development" | "staging" | "production";
  DEFAULT_CLASSIFICATION: string;
  LOG_CONTENT_DEBUG: boolean;

  /**
   * Xfeatures Account integration (ADR 0001). The URL is a plain var; the
   * client id/secret are secrets set with `wrangler secret put`. All three
   * unset means the Account principal path is disabled and denies (fail
   * closed) -- it never degrades into trusting the caller.
   */
  ACCOUNT_INTROSPECTION_URL?: string;
  ACCOUNT_CLIENT_ID?: string;
  ACCOUNT_CLIENT_SECRET?: string;
  /**
   * Optional Service Binding to Xfeatures Account. When present, introspection
   * is dispatched over it instead of the public internet: the request never
   * leaves Cloudflare's network, so it cannot be observed or intercepted in
   * transit, and it does not depend on public DNS resolving the Account
   * hostname from inside a Worker (ADR 0001 §3).
   *
   * `ACCOUNT_INTROSPECTION_URL` is still required — a Service Binding fetch
   * takes a full URL; only the transport changes.
   */
  ACCOUNT_SERVICE?: Fetcher;
  /**
   * The `client_id` of the single, pre-registered Xfeatures Account OAuth
   * application ("Athenaeum Developer Access") a human developer signs into
   * for personal REST/MCP access. An ordinary Account "user" application can
   * never carry the `athenaeum` scope (Account's own client_credentials-only
   * design for internal capabilities -- see ADR 0001 and Account's
   * `oauth_provider.ts`), so this is a second, narrower way in: only a
   * user-delegated token from exactly this client_id is accepted without that
   * scope. Unset disables the path entirely (fail closed, same as the other
   * Account integration vars).
   */
  ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID?: string;

  // Secrets (set via `wrangler secret put`, never in wrangler.jsonc).
  RPC_KEY_PEPPER: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

export interface IngestionQueueMessage {
  jobId: string;
  documentId: string;
  jobType: "index" | "reindex" | "delete";
}

// Minimal AI Search binding surface actually used by this project. See
// src/search/ai-search.ts for the retrieval call and docs/ARCHITECTURE.md
// for why only `search()` is used (retrieval-only, no generation).
//
// This mirrors the current AI Search contract, not the legacy AutoRAG one:
// filters are MongoDB-style objects keyed by metadata attribute name, and
// results come back as `chunks[]` with the source item nested under `item`.
// https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/
// https://developers.cloudflare.com/ai-search/api/search/workers-binding/

export type AISearchFilterValue = string | number | boolean;

/** The comparison operators AI Search accepts for a single attribute. */
export interface AISearchComparison {
  $eq?: AISearchFilterValue;
  $ne?: AISearchFilterValue;
  $in?: AISearchFilterValue[];
  $nin?: AISearchFilterValue[];
  $lt?: AISearchFilterValue;
  $lte?: AISearchFilterValue;
  $gt?: AISearchFilterValue;
  $gte?: AISearchFilterValue;
}

/**
 * Multiple keys are ANDed by the engine. There is no explicit `and`/`or`
 * wrapper and no nesting -- which is sufficient here, because every clause
 * the authorization layer produces is a conjunction.
 */
export type AISearchRetrievalFilters = Record<string, AISearchFilterValue | AISearchComparison>;

export interface AISearchOptions {
  retrieval: {
    retrieval_type: "hybrid" | "vector" | "keyword";
    match_threshold?: number;
    max_num_results?: number;
    filters?: AISearchRetrievalFilters;
    /**
     * Defaults to `true` upstream, meaning partial results are returned when
     * a processing step fails. A partially-processed query is not a query
     * whose ACL filter is known to have been applied, so this project always
     * sends `false` and treats a failure as a failure.
     */
    return_on_failure?: boolean;
  };
  query_rewrite?: { enabled: boolean };
  reranking?: { enabled: boolean; model?: string };
  cache?: { enabled: boolean };
}

export interface AISearchQuery {
  messages: { role: "user"; content: string }[];
  ai_search_options: AISearchOptions;
}

export interface AISearchResultItem {
  /** The source document's key in the data source -- for R2, the object key. */
  key?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface AISearchResultChunk {
  id?: string;
  type?: string;
  text: string;
  score: number;
  item?: AISearchResultItem;
}

export interface AISearchResponse {
  search_query?: string;
  chunks: AISearchResultChunk[];
}

/**
 * This project uses the `ai_search` *instance* binding (one fixed instance
 * per environment via `instance_name` in wrangler.jsonc), not the
 * `ai_search_namespaces` binding -- there is no per-agent/per-customer
 * dynamic instance need here, so the binding already resolves directly to
 * one instance and exposes `search()` without a `.get(name)` indirection.
 */
export interface AISearch {
  search(query: AISearchQuery): Promise<AISearchResponse>;
}
