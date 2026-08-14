import { assertAuthorized, authorize, documentDomainScope, permittedClassifications } from "../auth/authorize";
import { hasPermission } from "../auth/permissions";
import type { Principal } from "../auth/types";
import { LIMITS, type SearchDomain } from "../config";
import type { DocumentsRepository } from "../repositories/documents.repository";
import type { KnowledgeSearchProvider } from "../search/types";
import { log } from "../utils/logging";
import { isWithinValidityWindow } from "../utils/time";
import { ApiError, ErrorCode } from "../utils/responses";
import type { SearchResultDTO } from "./dto";

export interface SearchKnowledgeRequest {
  query: string;
  domain?: SearchDomain;
  language?: string;
  limit?: number;
}

export interface SearchKnowledgeResponse {
  results: SearchResultDTO[];
  reason?: "NO_RELIABLE_MATCH";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Semantic retrieval. Deterministic namespaces (facts,
 * products, plans, policies) should be reached through FactsService /
 * CatalogService / PoliciesService instead -- this path exists for "find me
 * something about X", not "give me the exact value of X".
 */
export class SearchService {
  constructor(
    private readonly provider: KnowledgeSearchProvider,
    private readonly documentsRepo: DocumentsRepository
  ) {}

  async searchKnowledge(principal: Principal, request: SearchKnowledgeRequest): Promise<SearchKnowledgeResponse> {
    const startedAt = Date.now();
    const response = await this.doSearch(principal, request);
    // Metadata only -- agent, domain, result shape, timing. Never the query text or retrieved content.
    log.info("knowledge_search", {
      agent_id: principal.agentId,
      domain: request.domain ?? null,
      result_count: response.results.length,
      duration_ms: Date.now() - startedAt
    });
    if (response.reason === "NO_RELIABLE_MATCH") {
      log.info("search_zero_results", { agent_id: principal.agentId, domain: request.domain ?? null });
    }
    return response;
  }

  private async doSearch(principal: Principal, request: SearchKnowledgeRequest): Promise<SearchKnowledgeResponse> {
    assertAuthorized(principal, { action: "knowledge.search" });

    const query = request.query.trim();
    if (query.length === 0 || query.length > LIMITS.QUERY_MAX_LENGTH) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, "Query is empty or exceeds the maximum length.");
    }

    // The classification set is never client-supplied -- it is
    // derived entirely from the authenticated principal's permissions.
    const classifications = permittedClassifications(principal);
    if (classifications.length === 0) {
      return { results: [], reason: "NO_RELIABLE_MATCH" };
    }

    // SR-004: the domain filter is derived from the principal FIRST, then
    // optionally narrowed by the client's requested domain. An earlier
    // revision left `domains` undefined whenever the client omitted the
    // parameter, which sent an unrestricted-by-domain query to the retrieval
    // engine and relied purely on the post-filter -- violating ACL-before-
    // retrieval and letting unreadable chunks consume the result budget.
    const scope = documentDomainScope(principal);
    let domains: string[] | undefined;
    if (scope.kind === "enumerated") {
      if (scope.domains.length === 0) {
        return { results: [], reason: "NO_RELIABLE_MATCH" };
      }
      domains = scope.domains;
    }

    // A client MAY narrow to a domain it can already read; it can never use
    // this parameter to broaden its own access.
    if (request.domain) {
      if (!hasPermission(principal.permissions, `documents.read.${request.domain}`)) {
        return { results: [], reason: "NO_RELIABLE_MATCH" };
      }
      domains = [request.domain];
    }

    const limit = clamp(request.limit ?? LIMITS.SEARCH_RESULTS_DEFAULT, 1, LIMITS.SEARCH_RESULTS_MAX);

    const chunks = await this.provider.search({
      query,
      filter: { classifications, domains, language: request.language },
      limit,
      minConfidence: LIMITS.SEARCH_MIN_CONFIDENCE_DEFAULT
    });
    if (chunks.length === 0) {
      return { results: [], reason: "NO_RELIABLE_MATCH" };
    }

    const documentIds = [...new Set(chunks.map((c) => c.documentId).filter((id): id is string => id !== null))];
    const liveDocuments = await this.documentsRepo.getManyByIds(documentIds);
    const liveById = new Map(liveDocuments.map((d) => [d.id, d] as const));

    const results: SearchResultDTO[] = [];
    for (const chunk of chunks) {
      if (!chunk.documentId) continue; // cannot verify freshness/ACL without a document to check against -- drop it
      const live = liveById.get(chunk.documentId);
      if (live?.status !== "active") continue; // index is stale relative to D1
      if (live.classification !== chunk.classification || live.domain !== chunk.domain) continue; // reclassified since last index
      // SR-005: an expired document must not be served as current evidence,
      // matching getDocument's behaviour exactly.
      if (!isWithinValidityWindow(live.valid_from, live.valid_until)) continue;

      const authz = authorize(principal, { action: "documents.read", resource: { domain: live.domain, classification: live.classification } });
      if (!authz.allowed) continue;

      // Everything describing the document comes from `live` (D1), never from
      // the index: the index supplies only the matched text and the score.
      results.push({
        type: "document_chunk",
        sourceId: chunk.sourceId,
        documentId: chunk.documentId,
        title: live.title,
        content: chunk.content,
        section: null,
        classification: live.classification,
        version: live.version,
        updatedAt: live.updated_at,
        score: chunk.score
      });
    }

    if (results.length === 0) {
      return { results: [], reason: "NO_RELIABLE_MATCH" };
    }
    return { results };
  }
}
