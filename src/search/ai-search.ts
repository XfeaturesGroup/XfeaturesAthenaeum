import metadataSchema from "./ai-search.metadata.json";
import type { AISearch, AISearchRetrievalFilters, Env } from "../env";
import { isClassification } from "../security/classification";
import { ApiError, ErrorCode } from "../utils/responses";
import type { KnowledgeSearchProvider, RetrievalChunk, RetrievalQuery } from "./types";

/**
 * The custom metadata attributes declared on the AI Search instance, and
 * written onto every indexed R2 object by the ingestion pipeline (see
 * src/storage/r2.ts DocumentR2Metadata).
 *
 * AI Search allows at most FIVE custom attributes per instance, so this set is
 * spent entirely on attributes the authorization filter needs at query time.
 * Everything a citation displays -- title, version, timestamps -- is read from
 * the live D1 row instead (src/knowledge/search.ts), which is both the
 * authoritative record and immune to a stale index.
 *
 * https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/
 */
export const AI_SEARCH_CUSTOM_METADATA_LIMIT = 5;

const METADATA_KEYS = {
  documentId: "document_id",
  classification: "classification",
  domain: "domain",
  language: "language",
  status: "status"
} as const;

export type AiSearchMetadataDataType = "text" | "number" | "boolean" | "datetime";

export interface AiSearchMetadataField {
  field_name: string;
  data_type: AiSearchMetadataDataType;
}

/**
 * The exact schema the instance must be configured with, read from the same
 * file `scripts/configure-ai-search.mjs` pushes to Cloudflare -- so the
 * deployed index and the filter this code sends cannot drift apart.
 * `tests/security/index-metadata-contract.test.ts` pins the relationship
 * between this schema, METADATA_KEYS, and what ingestion writes to R2.
 */
export const AI_SEARCH_CUSTOM_METADATA_SCHEMA: readonly AiSearchMetadataField[] =
  metadataSchema.custom_metadata as readonly AiSearchMetadataField[];

/**
 * Server-generated retrieval filters. Every clause here is
 * derived from the authenticated principal or from a fixed server-side
 * invariant -- none of it is client-controlled. The client's only influence
 * is narrowing `domains`, which SearchService has already intersected with
 * the principal's own scope.
 *
 * Filter keys are ANDed by AI Search, so a conjunction needs no wrapper.
 */
function buildFilters(filter: RetrievalQuery["filter"]): AISearchRetrievalFilters {
  const filters: AISearchRetrievalFilters = {
    [METADATA_KEYS.classification]: { $in: [...filter.classifications] },
    // Only published documents are ever retrievable. D1 remains authoritative
    // (SearchService re-checks every hit), but excluding non-active documents
    // at query time shrinks the stale-index window rather than relying on the
    // post-filter alone (SR-006).
    [METADATA_KEYS.status]: "active"
  };
  if (filter.domains && filter.domains.length > 0) {
    filters[METADATA_KEYS.domain] = { $in: [...filter.domains] };
  }
  if (filter.language) {
    filters[METADATA_KEYS.language] = filter.language;
  }
  return filters;
}

function readStringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * AI Search is retrieval-only here: only `search()` is ever called, never
 * `chatCompletions` (-- Xfeatures Athenaeum returns evidence, the
 * calling agent's own LLM generates the answer). The built-in AI Search
 * cache is explicitly disabled (`cache.enabled: false`): its cache key is
 * not documented to include our per-agent classification/domain filter, and
 * requires the security context be part of any cache key, so
 * until that is verified against current docs we do not risk a
 * public-agent query being served a cache entry populated under a broader
 * filter.
 */
export class AiSearchProvider implements KnowledgeSearchProvider {
  private readonly instance: AISearch;

  constructor(env: Env) {
    this.instance = env.AI_SEARCH;
  }

  async search(query: RetrievalQuery): Promise<RetrievalChunk[]> {
    if (query.filter.classifications.length === 0) {
      // No permitted classification tiers at all -> nothing can ever match.
      // Fail closed by returning no results rather than omitting the filter.
      return [];
    }

    let response;
    try {
      response = await this.instance.search({
        messages: [{ role: "user", content: query.query }],
        ai_search_options: {
          retrieval: {
            retrieval_type: "hybrid",
            match_threshold: query.minConfidence,
            max_num_results: query.limit,
            filters: buildFilters(query.filter),
            // A partial result set is a result set whose filter may not have
            // been applied. Fail rather than serve it.
            return_on_failure: false
          },
          query_rewrite: { enabled: true },
          reranking: { enabled: true },
          cache: { enabled: false }
        }
      });
    } catch {
      throw new ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Search index is temporarily unavailable.");
    }

    const permitted = new Set(query.filter.classifications);
    const chunks: RetrievalChunk[] = [];

    // The declared type says `chunks` is always present; the runtime value
    // comes from outside this codebase, so an unexpected shape yields nothing
    // rather than throwing or being read as something it is not.
    const returned = Array.isArray(response.chunks) ? response.chunks : [];

    for (const result of returned) {
      const metadata = result.item?.metadata;
      const classificationRaw = readStringMetadata(metadata, METADATA_KEYS.classification);

      // Defense in depth: even though the query above already
      // filtered server-side, never trust the index alone -- a chunk missing
      // classification metadata, or carrying a classification outside the
      // caller's permitted set, is dropped rather than shown.
      if (!isClassification(classificationRaw) || !permitted.has(classificationRaw)) {
        continue;
      }

      chunks.push({
        sourceId: result.item?.key ?? result.id ?? crypto.randomUUID(),
        documentId: readStringMetadata(metadata, METADATA_KEYS.documentId),
        content: result.text,
        classification: classificationRaw,
        domain: readStringMetadata(metadata, METADATA_KEYS.domain),
        score: result.score
      });
    }

    return chunks;
  }
}

export { METADATA_KEYS as AI_SEARCH_METADATA_KEYS };
