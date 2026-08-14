import assert from "node:assert/strict";
import { test } from "node:test";
import { AthenaeumApiError, AthenaeumClient } from "./index.js";

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("search() sends a bearer token and parses the envelope", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const client = new AthenaeumClient({
    baseUrl: "https://athenaeum.test",
    token: "test-token",
    fetch: fakeFetch((url, init) => {
      captured = { url, init };
      return jsonResponse({ request_id: "r1", results: [] });
    })
  });

  const result = await client.search({ query: "refund policy" });

  assert.ok(captured);
  assert.equal(captured.url, "https://athenaeum.test/v1/knowledge/search");
  assert.equal((captured.init.headers as Headers).get("authorization"), "Bearer test-token");
  assert.equal(result.request_id, "r1");
  assert.deepEqual(result.results, []);
});

test("getFact() unwraps the {fact} envelope", async () => {
  const client = new AthenaeumClient({
    baseUrl: "https://athenaeum.test",
    token: "t",
    fetch: fakeFetch(() => jsonResponse({ request_id: "r", fact: { namespace: "products", key: "widget-a", version: 1 } }))
  });

  const fact = await client.getFact("products", "widget-a");
  assert.equal(fact.key, "widget-a");
});

test("a non-2xx response with an error envelope throws AthenaeumApiError carrying code/status", async () => {
  const client = new AthenaeumClient({
    baseUrl: "https://athenaeum.test",
    token: "t",
    fetch: fakeFetch(() => jsonResponse({ error: { code: "FORBIDDEN", message: "Access denied", request_id: "r2" } }, 403))
  });

  await assert.rejects(
    () => client.getFact("secrets", "x"),
    (error: unknown) => {
      assert.ok(error instanceof AthenaeumApiError);
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.status, 403);
      assert.equal(error.requestId, "r2");
      return true;
    }
  );
});

test("proposeDocument() sends a multipart body with metadata + file parts, never JSON", async () => {
  let capturedBody: FormData | undefined;
  const client = new AthenaeumClient({
    baseUrl: "https://athenaeum.test",
    token: "t",
    fetch: fakeFetch((_url, init) => {
      capturedBody = init.body as FormData;
      return jsonResponse({ request_id: "r", document: { id: "doc1", slug: "x", status: "draft" } }, 201);
    })
  });

  const doc = await client.proposeDocument({
    slug: "onboarding",
    title: "Onboarding",
    domain: "support",
    classification: "INTERNAL",
    language: "en",
    content: "# Hello"
  });

  assert.equal(doc.id, "doc1");
  assert.ok(capturedBody instanceof FormData);
  const metadataRaw = capturedBody.get("metadata");
  assert.equal(typeof metadataRaw, "string");
  const metadata = JSON.parse(metadataRaw as string) as { slug: string };
  assert.equal(metadata.slug, "onboarding");
  assert.ok(capturedBody.get("file") instanceof Blob);
});

test("submitDocumentForReview() maps snake_case to camelCase", async () => {
  const client = new AthenaeumClient({
    baseUrl: "https://athenaeum.test",
    token: "t",
    fetch: fakeFetch(() => jsonResponse({ request_id: "r", submission: { document_id: "doc1", workflow_instance_id: "wf1" } }))
  });

  const result = await client.submitDocumentForReview("doc1");
  assert.deepEqual(result, { documentId: "doc1", workflowInstanceId: "wf1" });
});
