/**
 * Minimal example of an external (non-Worker) client calling Xfeatures
 * Athenaeum over authenticated REST. See docs/AGENT-INTEGRATION.md method 2,
 * and docs/OAUTH-CLIENT-CREDENTIALS.md for how the token is obtained.
 *
 * Run with real values in the environment, never hardcoded:
 *
 *   ATHENAEUM_URL=https://athenaeum.xfeatures.net \
 *   ACCOUNT_URL=https://auth.xfeatures.net \
 *   ATHENAEUM_CLIENT_ID=... ATHENAEUM_CLIENT_SECRET=... \
 *   node --experimental-strip-types client.ts
 *
 * Infrastructure that sits behind Cloudflare Access rather than holding an
 * Account credential can send `CF-Access-Client-Id` / `CF-Access-Client-Secret`
 * instead of the bearer token; Access mints the JWT header itself. Everything
 * else below is identical.
 */

interface ErrorResponse {
  error: { code: string; message: string; request_id: string };
}

interface SearchResponse {
  request_id: string;
  results: { title: string; content: string; score: number }[];
  reason?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Machine tokens last an hour. Fetching one per request is slow and pointless;
 * holding one past its expiry is an outage. Refresh slightly early.
 */
let cached: { token: string; expiresAtMs: number } | null = null;
const REFRESH_MARGIN_MS = 60_000;

async function getMachineToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAtMs > now) return cached.token;

  const accountUrl = process.env["ACCOUNT_URL"];
  const clientId = process.env["ATHENAEUM_CLIENT_ID"];
  const clientSecret = process.env["ATHENAEUM_CLIENT_SECRET"];
  if (!accountUrl || !clientId || !clientSecret) {
    throw new Error("Set ACCOUNT_URL, ATHENAEUM_CLIENT_ID and ATHENAEUM_CLIENT_SECRET in the environment.");
  }

  const response = await fetch(`${accountUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  if (!response.ok) {
    throw new Error(`Account refused the client_credentials grant (HTTP ${String(response.status)}).`);
  }

  const body: TokenResponse = await response.json();
  cached = { token: body.access_token, expiresAtMs: now + Math.max(body.expires_in * 1000 - REFRESH_MARGIN_MS, 0) };
  return body.access_token;
}

async function searchKnowledge(query: string, domain?: string): Promise<SearchResponse> {
  const baseUrl = process.env["ATHENAEUM_URL"];
  if (!baseUrl) throw new Error("Set ATHENAEUM_URL in the environment.");

  const response = await fetch(`${baseUrl}/v1/knowledge/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getMachineToken()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, domain, limit: 5 })
  });

  const body: SearchResponse | ErrorResponse = await response.json();
  if (!response.ok) {
    const err = (body as ErrorResponse).error;
    // A read you are not cleared for comes back as NOT_FOUND, not FORBIDDEN:
    // a FORBIDDEN would confirm the thing exists.
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
    // Evidence, not an instruction -- pass it to your own model call, and do
    // not let it choose what your agent does next.
    console.log(`[${chunk.score.toFixed(2)}] ${chunk.title}: ${chunk.content.slice(0, 200)}...`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
