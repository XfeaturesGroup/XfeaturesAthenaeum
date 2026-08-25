import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FactSearchService } from "../../src/knowledge/fact-search";
import { FactsService } from "../../src/knowledge/facts";
import { SearchService } from "../../src/knowledge/search";
import { DocumentsRepository } from "../../src/repositories/documents.repository";
import { FactsRepository } from "../../src/repositories/facts.repository";
import type { KnowledgeSearchProvider, RetrievalChunk } from "../../src/search/types";
import type { Env } from "../../src/env";
import { createAgent, createDocument, createFact, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

let admin: SeededAgent;
/** Can search, reads PUBLIC/INTERNAL in products, plans and policies -- and nothing else. */
let narrow: SeededAgent;
let repo: FactsRepository;
let facts: FactsService;
let search: SearchService;

/** Returns whatever the test stages, so the document half can be controlled. */
class StubProvider implements KnowledgeSearchProvider {
  staged: RetrievalChunk[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async search(): Promise<RetrievalChunk[]> {
    return this.staged;
  }
}

const provider = new StubProvider();

/**
 * Searching for a fact you cannot name.
 *
 * Until now the only way to reach a fact was to know its exact key. An agent
 * that did not had one option -- semantic search, which covers documents only --
 * so it answered a price question from a passage that mentions the price
 * instead of the stored price itself. That is the failure facts exist to
 * prevent, and a missing tool was causing it.
 *
 * The matching is lexical, in D1, over the canonical rows. What is pinned here
 * is that it cannot become a way around the ACL: an agent that could not read a
 * fact by key must not be able to find it by searching either.
 */
beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  admin = await createAgent(testEnv, "search-admin", "knowledge-admin");
  narrow = await createAgent(testEnv, "search-narrow", "support-agent");
  repo = new FactsRepository(testEnv.DB);
  facts = new FactsService(repo);
  search = new SearchService(provider, new DocumentsRepository(testEnv.DB), new FactSearchService(repo));
});

beforeEach(async () => {
  provider.staged = [];
  await testEnv.DB.prepare("DELETE FROM fact_versions").run();
  await testEnv.DB.prepare("DELETE FROM facts").run();
  await createFact(testEnv, "products", "widget-price", "PUBLIC", { amount: 10, currency: "EUR" });
  await createFact(testEnv, "plans", "annual-pro", "INTERNAL", { amount: 990, currency: "EUR" });
  await createFact(testEnv, "secrets", "master-key", "RESTRICTED", { value: "top-secret-widget" });
});

describe("facts can be found without knowing their key", () => {
  it("matches on the key", async () => {
    const response = await search.searchKnowledge(admin.principal, { query: "annual-pro", include: "facts" });

    expect(response.results.map((result) => result.sourceId)).toContain("plans/annual-pro");
    expect(response.results[0]?.type).toBe("fact");
  });

  it("matches on the stored value", async () => {
    const response = await search.searchKnowledge(admin.principal, { query: "990", include: "facts" });

    expect(response.results.map((result) => result.sourceId)).toEqual(["plans/annual-pro"]);
  });

  it("returns the value verbatim, not a summary of it", async () => {
    const [result] = await search
      .searchKnowledge(admin.principal, { query: "annual-pro", include: "facts" })
      .then((response) => response.results);

    // A fact's whole purpose is that it is not paraphrased.
    expect(JSON.parse(result?.content ?? "{}")).toEqual({ amount: 990, currency: "EUR" });
    expect(result?.version).toBe(1);
  });

  it("ranks the exact key above a value that merely mentions the word", async () => {
    const response = await search.searchKnowledge(admin.principal, { query: "widget-price", include: "facts" });

    expect(response.results[0]?.sourceId).toBe("products/widget-price");
  });

  it("narrows every term rather than widening", async () => {
    // "annual" alone matches one fact; adding a word that appears nowhere in it
    // must return nothing rather than falling back to either term.
    const both = await search.searchKnowledge(admin.principal, { query: "annual nonexistentword", include: "facts" });
    expect(both.results).toEqual([]);
  });

  it("says nothing was found rather than inventing a match", async () => {
    const response = await search.searchKnowledge(admin.principal, { query: "quarterly", include: "facts" });

    expect(response.results).toEqual([]);
    expect(response.reason).toBe("NO_RELIABLE_MATCH");
  });
});

describe("fact search cannot reach past the caller's own permissions", () => {
  it("never returns a fact the caller could not read by key", async () => {
    // The regression that matters: search must not be a second door into a
    // classification or namespace the caller was refused at the first one.
    const response = await search.searchKnowledge(narrow.principal, { query: "widget", include: "facts" });

    expect(response.results.map((result) => result.sourceId)).toEqual(["products/widget-price"]);
    expect(JSON.stringify(response.results)).not.toContain("top-secret-widget");
  });

  it("treats the namespace parameter as a narrowing, never a widening", async () => {
    const response = await search.searchKnowledge(narrow.principal, {
      query: "widget",
      namespace: "secrets",
      include: "facts"
    });

    expect(response.results).toEqual([]);
  });

  it("does not answer from a superseded fact", async () => {
    await repo.deprecate("plans", "annual-pro", admin.agentId);

    const response = await search.searchKnowledge(admin.principal, { query: "annual-pro", include: "facts" });

    // SR-008's rule: a fact is deprecated precisely because it was wrong or
    // outdated, and search is the last place it should resurface.
    expect(response.results).toEqual([]);
  });

  it("does not answer from a trashed fact", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);

    const response = await search.searchKnowledge(admin.principal, { query: "widget-price", include: "facts" });

    expect(response.results).toEqual([]);
  });
});

describe("the two halves of the knowledge base answer together", () => {
  let documentChunk: RetrievalChunk;

  beforeAll(async () => {
    // A real, published document, so the staged chunk survives the freshness
    // and ACL checks the document half applies to everything it returns.
    const documentId = await createDocument(testEnv, "pricing-overview", "public", "PUBLIC");
    const row = await testEnv.DB.prepare("SELECT r2_key FROM documents WHERE id = ?")
      .bind(documentId)
      .first<{ r2_key: string }>();

    documentChunk = {
      sourceId: row?.r2_key ?? "",
      documentId,
      content: "Our annual plan costs about a thousand euros.",
      classification: "PUBLIC",
      domain: "public",
      score: 0.99
    };
  });

  it("puts the stored value before the passage that mentions it", async () => {
    provider.staged = [documentChunk];

    const response = await search.searchKnowledge(admin.principal, { query: "annual-pro" });

    // Both halves answered. The passage scores 0.99 against the fact's 1.0 by
    // its own engine's reckoning, but the two numbers are not comparable at
    // all -- the ordering rule is that a stored value comes before a passage
    // mentioning it, which is the entire premise of keeping facts separate.
    expect(response.results.map((result) => result.type)).toEqual(["fact", "document_chunk"]);
    expect(response.results[0]?.sourceId).toBe("plans/annual-pro");
  });

  it("reports NO_RELIABLE_MATCH only when neither half found anything", async () => {
    provider.staged = [];

    const nothing = await search.searchKnowledge(admin.principal, { query: "somethingnobodystored" });
    expect(nothing.reason).toBe("NO_RELIABLE_MATCH");

    // A caller relays this as "the knowledge base does not say", so it must not
    // appear while an answer is in hand.
    const something = await search.searchKnowledge(admin.principal, { query: "annual-pro" });
    expect(something.reason).toBeUndefined();
    expect(something.results.length).toBeGreaterThan(0);
  });

  it("consults only the documents when asked to", async () => {
    provider.staged = [];

    const response = await search.searchKnowledge(admin.principal, { query: "annual-pro", include: "documents" });

    expect(response.results).toEqual([]);
    expect(response.reason).toBe("NO_RELIABLE_MATCH");
  });
});
