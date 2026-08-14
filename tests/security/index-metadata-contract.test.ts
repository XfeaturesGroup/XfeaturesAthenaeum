import { describe, expect, it } from "vitest";
import {
  AiSearchProvider,
  AI_SEARCH_CUSTOM_METADATA_LIMIT,
  AI_SEARCH_CUSTOM_METADATA_SCHEMA,
  AI_SEARCH_METADATA_KEYS
} from "../../src/search/ai-search";
import type { AISearchQuery, AISearchResponse, Env } from "../../src/env";
import type { DocumentR2Metadata } from "../../src/storage/r2";
import type { RetrievalQuery } from "../../src/search/types";

/**
 * SR-019 regression.
 *
 * The retrieval ACL is enforced in two places: a server-generated filter sent
 * to AI Search (ACL *before* retrieval) and a re-check against D1 afterwards.
 * The pre-filter is only real if it is expressed in the syntax the engine
 * actually parses and references attributes the index actually carries. An
 * earlier revision emitted the legacy AutoRAG filter shape
 * (`{ and: [{ in: {...} }, { eq: {...} }] }`) and read a legacy response shape
 * (`{ data: [{ content, metadata, filename }] }`), neither of which matches
 * the current AI Search contract. These tests pin both halves of that
 * contract so a silent upstream/shape drift fails here instead of degrading
 * into an unfiltered query.
 *
 * Contract source:
 * https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/
 * https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/
 * https://developers.cloudflare.com/ai-search/api/search/workers-binding/
 */

/** Captures the exact request handed to the engine, and replays a staged response. */
class CapturingInstance {
  lastQuery: AISearchQuery | null = null;
  staged: AISearchResponse = { chunks: [] };

  // eslint-disable-next-line @typescript-eslint/require-await
  async search(query: AISearchQuery): Promise<AISearchResponse> {
    this.lastQuery = query;
    return this.staged;
  }
}

function providerWith(instance: CapturingInstance): AiSearchProvider {
  return new AiSearchProvider({ AI_SEARCH: instance } as unknown as Env);
}

const baseQuery: RetrievalQuery = {
  query: "anything",
  filter: { classifications: ["PUBLIC", "INTERNAL"] },
  limit: 10,
  minConfidence: 0.4
};

describe("declared custom metadata stays within the AI Search instance limits", () => {
  it("declares no more attributes than an instance supports", () => {
    expect(AI_SEARCH_CUSTOM_METADATA_SCHEMA.length).toBeLessThanOrEqual(AI_SEARCH_CUSTOM_METADATA_LIMIT);
  });

  it("uses no reserved attribute name", () => {
    const reserved = new Set(["timestamp", "folder", "filename"]);
    for (const field of AI_SEARCH_CUSTOM_METADATA_SCHEMA) {
      expect(reserved.has(field.field_name)).toBe(false);
    }
  });

  it("declares attribute names in the lowercase form the index stores", () => {
    for (const field of AI_SEARCH_CUSTOM_METADATA_SCHEMA) {
      expect(field.field_name).toBe(field.field_name.toLowerCase());
    }
  });

  it("declares every attribute the ingestion pipeline actually writes to R2", () => {
    // Compile-time proof that each declared name is a real DocumentR2Metadata
    // key: if a name is dropped from the interface, this object stops typing.
    const written: Record<keyof DocumentR2Metadata, true> = {
      document_id: true,
      classification: true,
      domain: true,
      title: true,
      version: true,
      language: true,
      status: true,
      updated_at: true
    };
    for (const field of AI_SEARCH_CUSTOM_METADATA_SCHEMA) {
      expect(Object.keys(written)).toContain(field.field_name);
    }
  });

  it("declares every attribute the retrieval filter can reference", () => {
    const declared = new Set(AI_SEARCH_CUSTOM_METADATA_SCHEMA.map((f) => f.field_name));
    for (const key of Object.values(AI_SEARCH_METADATA_KEYS)) {
      expect(declared.has(key)).toBe(true);
    }
  });
});

describe("the filter sent to AI Search is in the syntax the engine parses", () => {
  it("always constrains classification with $in, never an unfiltered query", async () => {
    const instance = new CapturingInstance();
    await providerWith(instance).search(baseQuery);

    const filters = instance.lastQuery?.ai_search_options.retrieval.filters;
    expect(filters).toBeDefined();
    expect(filters?.[AI_SEARCH_METADATA_KEYS.classification]).toEqual({ $in: ["PUBLIC", "INTERNAL"] });
  });

  it("always constrains status to active", async () => {
    const instance = new CapturingInstance();
    await providerWith(instance).search(baseQuery);

    expect(instance.lastQuery?.ai_search_options.retrieval.filters?.[AI_SEARCH_METADATA_KEYS.status]).toBe("active");
  });

  it("emits no legacy compound wrapper, which the engine would not parse", async () => {
    const instance = new CapturingInstance();
    await providerWith(instance).search(baseQuery);

    const filters = instance.lastQuery?.ai_search_options.retrieval.filters ?? {};
    for (const legacyKey of ["and", "or", "eq", "in", "type", "filters"]) {
      expect(Object.keys(filters)).not.toContain(legacyKey);
    }
  });

  it("constrains domain with $in when the principal's scope is enumerated", async () => {
    const instance = new CapturingInstance();
    await providerWith(instance).search({ ...baseQuery, filter: { ...baseQuery.filter, domains: ["support"] } });

    expect(instance.lastQuery?.ai_search_options.retrieval.filters?.[AI_SEARCH_METADATA_KEYS.domain]).toEqual({
      $in: ["support"]
    });
  });

  it("never asks the engine for partial results", async () => {
    // return_on_failure defaults to true upstream: a partially-processed query
    // is not a query whose ACL filter is known to have been applied.
    const instance = new CapturingInstance();
    await providerWith(instance).search(baseQuery);

    expect(instance.lastQuery?.ai_search_options.retrieval.return_on_failure).toBe(false);
  });

  it("never enables the engine-side cache, whose key does not include our filter", async () => {
    const instance = new CapturingInstance();
    await providerWith(instance).search(baseQuery);

    expect(instance.lastQuery?.ai_search_options.cache?.enabled).toBe(false);
  });

  it("does not call the engine at all when no classification is permitted", async () => {
    const instance = new CapturingInstance();
    const chunks = await providerWith(instance).search({ ...baseQuery, filter: { classifications: [] } });

    expect(chunks).toEqual([]);
    expect(instance.lastQuery).toBeNull();
  });
});

describe("results are read from the response shape the engine actually returns", () => {
  it("maps a current-shape chunk, keying identity off item.metadata", async () => {
    const instance = new CapturingInstance();
    instance.staged = {
      chunks: [
        {
          text: "body",
          score: 0.9,
          item: {
            key: "knowledge/public/public/doc-1/v1.bin",
            metadata: { document_id: "doc-1", classification: "PUBLIC", domain: "public", status: "active" }
          }
        }
      ]
    };

    const chunks = await providerWith(instance).search(baseQuery);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.documentId).toBe("doc-1");
    expect(chunks[0]?.classification).toBe("PUBLIC");
    expect(chunks[0]?.domain).toBe("public");
    expect(chunks[0]?.content).toBe("body");
    expect(chunks[0]?.sourceId).toBe("knowledge/public/public/doc-1/v1.bin");
  });

  it("drops a chunk carrying no classification metadata rather than defaulting it", async () => {
    const instance = new CapturingInstance();
    instance.staged = {
      chunks: [{ text: "body", score: 0.9, item: { key: "k", metadata: { document_id: "doc-1" } } }]
    };

    expect(await providerWith(instance).search(baseQuery)).toEqual([]);
  });

  it("drops a chunk whose classification is outside the caller's permitted set", async () => {
    const instance = new CapturingInstance();
    instance.staged = {
      chunks: [
        {
          text: "restricted body",
          score: 0.99,
          item: { key: "k", metadata: { document_id: "doc-1", classification: "RESTRICTED", domain: "network" } }
        }
      ]
    };

    const chunks = await providerWith(instance).search(baseQuery);
    expect(chunks).toEqual([]);
    expect(JSON.stringify(chunks)).not.toContain("restricted body");
  });

  it("yields nothing from a legacy-shaped response instead of guessing at it", async () => {
    // The exact failure mode SR-019 describes: reading `data[].content` from a
    // response that has none. Fail closed, do not invent a mapping.
    const instance = new CapturingInstance();
    instance.staged = {
      data: [{ content: "body", score: 0.9, metadata: { document_id: "doc-1", classification: "PUBLIC" } }]
    } as unknown as AISearchResponse;

    expect(await providerWith(instance).search(baseQuery)).toEqual([]);
  });
});
