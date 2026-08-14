import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { SearchService } from "../../src/knowledge/search";
import { DocumentsRepository } from "../../src/repositories/documents.repository";
import type { KnowledgeSearchProvider, RetrievalChunk, RetrievalQuery } from "../../src/search/types";
import type { Env } from "../../src/env";
import { createAgent, createDocument, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

let publicAgent: SeededAgent;
let supportAgent: SeededAgent;
let adminAgent: SeededAgent;

let restrictedDocId: string;
let supportDocId: string;
let publicDocId: string;
let networkDocId: string;

/** Records the filter it was asked for, and returns whatever the test stages. */
class SpyProvider implements KnowledgeSearchProvider {
  lastQuery: RetrievalQuery | null = null;
  staged: RetrievalChunk[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async search(query: RetrievalQuery): Promise<RetrievalChunk[]> {
    this.lastQuery = query;
    return this.staged;
  }
}

function chunk(documentId: string, classification: RetrievalChunk["classification"], domain: string): RetrievalChunk {
  return {
    sourceId: `src-${documentId}`,
    documentId,
    content: "sensitive body text",
    classification,
    domain,
    score: 0.99
  };
}

beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  publicAgent = await createAgent(testEnv, "ret-public", "public-agent");
  supportAgent = await createAgent(testEnv, "ret-support", "support-agent");
  adminAgent = await createAgent(testEnv, "ret-admin", "knowledge-admin");

  publicDocId = await createDocument(testEnv, "public-doc", "public", "PUBLIC");
  supportDocId = await createDocument(testEnv, "support-doc", "support", "INTERNAL");
  restrictedDocId = await createDocument(testEnv, "restricted-doc", "network", "RESTRICTED");
  networkDocId = await createDocument(testEnv, "network-doc", "network", "INTERNAL");
});

function buildSearch(provider: SpyProvider): SearchService {
  return new SearchService(provider, new DocumentsRepository(testEnv.DB));
}

/**
 * SR-004 regression: the retrieval query itself must be constrained to what
 * the principal may read. An earlier revision only filtered by classification
 * when the caller omitted `domain`, sending an effectively unrestricted-by-
 * domain query and relying on post-filtering alone.
 */
describe("SR-004: ACL is applied before retrieval, not only after", () => {
  it("constrains classification to the principal's tiers even with no domain requested", async () => {
    const provider = new SpyProvider();
    await buildSearch(provider).searchKnowledge(publicAgent.principal, { query: "anything" });

    expect(provider.lastQuery).not.toBeNull();
    expect(provider.lastQuery?.filter.classifications).toEqual(["PUBLIC"]);
  });

  it("constrains DOMAIN even when the caller omits the domain parameter", async () => {
    const provider = new SpyProvider();
    await buildSearch(provider).searchKnowledge(supportAgent.principal, { query: "anything" });

    const domains = provider.lastQuery?.filter.domains;
    expect(domains).toBeDefined();
    expect([...(domains ?? [])].sort()).toEqual(["public", "support"]);
    expect(domains).not.toContain("network");
  });

  it("never sends an unrestricted query for a principal with a wildcard-free scope", async () => {
    const provider = new SpyProvider();
    await buildSearch(provider).searchKnowledge(publicAgent.principal, { query: "anything" });
    expect(provider.lastQuery?.filter.domains).toEqual(["public"]);
  });

  it("omits the domain restriction only for a documents.read.* holder", async () => {
    const provider = new SpyProvider();
    await buildSearch(provider).searchKnowledge(adminAgent.principal, { query: "anything" });
    // knowledge-admin fixture holds explicit domains, so it still enumerates.
    expect(provider.lastQuery?.filter.domains).toBeDefined();
  });

  it("short-circuits without querying at all when the principal can read no domain", async () => {
    const provider = new SpyProvider();
    const noDomains: SeededAgent["principal"] = {
      ...publicAgent.principal,
      permissions: new Set(["knowledge.search", "knowledge.classification.PUBLIC"])
    };
    const result = await buildSearch(provider).searchKnowledge(noDomains, { query: "anything" });

    expect(result.results).toEqual([]);
    expect(result.reason).toBe("NO_RELIABLE_MATCH");
    expect(provider.lastQuery).toBeNull(); // the engine was never called
  });

  it("a client-supplied domain can narrow but never broaden scope", async () => {
    const provider = new SpyProvider();
    const result = await buildSearch(provider).searchKnowledge(supportAgent.principal, {
      query: "anything",
      domain: "network" // support agent has no network scope
    });

    expect(result.results).toEqual([]);
    expect(result.reason).toBe("NO_RELIABLE_MATCH");
    expect(provider.lastQuery).toBeNull();
  });

  it("a client-supplied domain the caller DOES hold narrows to exactly that domain", async () => {
    const provider = new SpyProvider();
    await buildSearch(provider).searchKnowledge(supportAgent.principal, { query: "anything", domain: "support" });
    expect(provider.lastQuery?.filter.domains).toEqual(["support"]);
  });
});

/**
 * SR-005 / stale-index regression: the search index is not authoritative.
 * Even if it returns a chunk, D1 decides whether that document is still
 * active, still in that domain, and still at that classification.
 */
describe("stale or hostile index results are re-validated against D1", () => {
  it("drops a chunk for a document that has since been archived", async () => {
    const archivedId = await createDocument(testEnv, "since-archived", "public", "PUBLIC", "archived");
    const provider = new SpyProvider();
    provider.staged = [chunk(archivedId, "PUBLIC", "public")];

    const result = await buildSearch(provider).searchKnowledge(publicAgent.principal, { query: "anything" });
    expect(result.results).toEqual([]);
    expect(result.reason).toBe("NO_RELIABLE_MATCH");
  });

  it("drops a chunk whose indexed classification no longer matches D1", async () => {
    // Index still claims PUBLIC; D1 says the document is RESTRICTED.
    const provider = new SpyProvider();
    provider.staged = [chunk(restrictedDocId, "PUBLIC", "network")];

    const result = await buildSearch(provider).searchKnowledge(publicAgent.principal, { query: "anything" });
    expect(result.results).toEqual([]);
  });

  it("drops a chunk whose indexed domain no longer matches D1", async () => {
    const provider = new SpyProvider();
    provider.staged = [chunk(supportDocId, "INTERNAL", "public")]; // real domain is "support"

    const result = await buildSearch(provider).searchKnowledge(supportAgent.principal, { query: "anything" });
    expect(result.results).toEqual([]);
  });

  it("drops a chunk with no document_id, since it cannot be re-validated", async () => {
    const provider = new SpyProvider();
    provider.staged = [{ ...chunk(publicDocId, "PUBLIC", "public"), documentId: null }];

    const result = await buildSearch(provider).searchKnowledge(publicAgent.principal, { query: "anything" });
    expect(result.results).toEqual([]);
  });

  it("drops a RESTRICTED chunk a compromised index hands to a public agent", async () => {
    // The single most important property: even if the retrieval layer is
    // fully compromised and returns restricted content, nothing leaks.
    const provider = new SpyProvider();
    provider.staged = [chunk(restrictedDocId, "RESTRICTED", "network")];

    const result = await buildSearch(provider).searchKnowledge(publicAgent.principal, { query: "anything" });
    expect(result.results).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("sensitive body text");
  });

  it("drops a network-domain chunk handed to a support agent", async () => {
    const provider = new SpyProvider();
    provider.staged = [chunk(networkDocId, "INTERNAL", "network")];

    const result = await buildSearch(provider).searchKnowledge(supportAgent.principal, { query: "anything" });
    expect(result.results).toEqual([]);
  });

  it("returns a chunk that genuinely passes every check", async () => {
    const provider = new SpyProvider();
    provider.staged = [chunk(publicDocId, "PUBLIC", "public")];

    const result = await buildSearch(provider).searchKnowledge(publicAgent.principal, { query: "anything" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.documentId).toBe(publicDocId);
  });

  /**
   * SR-019: the index supplies the matched text and nothing else. Everything a
   * citation asserts about a document -- its title, its version, when it last
   * changed -- is read from the D1 row, so a stale or tampered index cannot
   * make a document appear to say something it does not, or appear current
   * when it is not.
   */
  it("takes citation title, version and timestamp from D1, not from the index", async () => {
    const provider = new SpyProvider();
    provider.staged = [chunk(publicDocId, "PUBLIC", "public")];

    const result = await buildSearch(provider).searchKnowledge(publicAgent.principal, { query: "anything" });
    const live = await new DocumentsRepository(testEnv.DB).getById(publicDocId);

    expect(live).not.toBeNull();
    expect(result.results[0]?.title).toBe(live?.title);
    expect(result.results[0]?.version).toBe(live?.version);
    expect(result.results[0]?.updatedAt).toBe(live?.updated_at);
  });
});

/**
 * Cross-agent isolation: the same staged index response must yield different
 * results per principal. This is the property a shared cache would break,
 * which is why caching stays disabled (SR-016).
 */
describe("cross-agent isolation on identical queries", () => {
  it("the same query and same index response leaks nothing across principals", async () => {
    const provider = new SpyProvider();
    provider.staged = [chunk(publicDocId, "PUBLIC", "public"), chunk(supportDocId, "INTERNAL", "support")];

    const search = buildSearch(provider);
    const supportResult = await search.searchKnowledge(supportAgent.principal, { query: "identical question" });
    const publicResult = await search.searchKnowledge(publicAgent.principal, { query: "identical question" });

    expect(supportResult.results.map((r) => r.documentId).sort()).toEqual([publicDocId, supportDocId].sort());
    expect(publicResult.results.map((r) => r.documentId)).toEqual([publicDocId]);
  });

  it("querying as a privileged agent first does not warm anything for a weaker agent", async () => {
    const provider = new SpyProvider();
    provider.staged = [chunk(supportDocId, "INTERNAL", "support")];
    const search = buildSearch(provider);

    await search.searchKnowledge(supportAgent.principal, { query: "same" });
    const publicResult = await search.searchKnowledge(publicAgent.principal, { query: "same" });

    expect(publicResult.results).toEqual([]);
  });
});
