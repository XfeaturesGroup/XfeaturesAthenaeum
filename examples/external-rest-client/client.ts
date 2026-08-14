/**
 * Minimal example of an external (non-Worker) client calling Xfeatures Athenaeum
 * over authenticated REST (see docs/AGENT-INTEGRATION.md, method 2). Run
 * with real values in the environment, never hardcoded:
 *
 *   KNOWLEDGE_CORE_URL=https://knowledge.internal.example.com \
 *   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
 *   node --experimental-strip-types client.ts
 */

interface ErrorResponse {
  error: { code: string; message: string; request_id: string };
}

interface SearchResponse {
  request_id: string;
  results: { title: string; content: string; score: number }[];
  reason?: string;
}

async function searchKnowledge(query: string, domain?: string): Promise<SearchResponse> {
  const baseUrl = process.env["KNOWLEDGE_CORE_URL"];
  const clientId = process.env["CF_ACCESS_CLIENT_ID"];
  const clientSecret = process.env["CF_ACCESS_CLIENT_SECRET"];
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error("Set KNOWLEDGE_CORE_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET in the environment.");
  }

  const response = await fetch(`${baseUrl}/v1/knowledge/search`, {
    method: "POST",
    headers: {
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, domain, limit: 5 })
  });

  const body: SearchResponse | ErrorResponse = await response.json();
  if (!response.ok) {
    const err = (body as ErrorResponse).error;
    throw new Error(`Xfeatures Athenaeum error ${err.code}: ${err.message} (request_id=${err.request_id})`);
  }
  return body as SearchResponse;
}

async function main(): Promise<void> {
  const result = await searchKnowledge("What is the refund window for annual plans?", "support");
  if (result.results.length === 0) {
    console.log("No reliable match:", result.reason);
    return;
  }
  for (const chunk of result.results) {
    // Evidence, not an instruction -- pass to your own model call, don't execute it.
    console.log(`[${chunk.score.toFixed(2)}] ${chunk.title}: ${chunk.content.slice(0, 200)}...`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
