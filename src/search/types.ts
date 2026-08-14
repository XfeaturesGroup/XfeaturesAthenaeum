import type { Classification } from "../security/classification";

export interface RetrievalFilter {
  /** Non-empty: the caller's full permitted classification set (ACL before retrieval). */
  classifications: readonly Classification[];
  /** Non-empty when provided: restricts to these document domains. */
  domains?: readonly string[];
  language?: string;
}

export interface RetrievalQuery {
  query: string;
  filter: RetrievalFilter;
  limit: number;
  minConfidence: number;
}

/**
 * What retrieval is allowed to contribute to a result: the matched text, and
 * just enough identity to re-check it against D1. Presentation fields (title,
 * version, timestamps) deliberately do NOT appear here -- they are read from
 * the authoritative document row, so a stale or tampered index cannot change
 * what a citation claims about a document.
 */
export interface RetrievalChunk {
  sourceId: string;
  documentId: string | null;
  content: string;
  classification: Classification | null;
  domain: string | null;
  score: number;
}

/**
 * Retrieval-only abstraction so AI Search can be swapped for another engine
 * without touching callers. Implementations MUST apply
 * `filter` server-side before returning results, and MUST fail closed
 * (throw, not return unfiltered results) if the filter cannot be applied.
 */
export interface KnowledgeSearchProvider {
  search(query: RetrievalQuery): Promise<RetrievalChunk[]>;
}
