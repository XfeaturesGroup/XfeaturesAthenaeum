# @xfeatures/athenaeum-sdk

Thin REST client for Xfeatures Athenaeum. No dependencies beyond the platform `fetch()` — one method per endpoint, no retry/caching logic, every error surfaces as `AthenaeumApiError` (never swallowed).

```ts
import { AthenaeumClient } from "@xfeatures/athenaeum-sdk";

const athenaeum = new AthenaeumClient({
  baseUrl: "https://xfeatures-athenaeum.xfeatures.workers.dev",
  token: accountAccessToken // any Xfeatures Account bearer token Athenaeum accepts -- see docs/AGENT-INTEGRATION.md
});

const { results } = await athenaeum.search({ query: "refund window for annual plans", domain: "support" });
const plan = await athenaeum.getPlan("annual-pro");
```

## Human-in-the-loop writes

`proposeDocument()` creates a DRAFT only — it is never visible to search or `getDocument()` until a human approves it in HQ. `submitDocumentForReview()` hands that draft to a reviewer. Neither method, nor any other in this SDK, can publish a document; there is no `publish()`/`approve()` method here at all, matching the same design as the MCP tools of the same names (`knowledge_propose_document` / `knowledge_submit_document_for_review` in `xfeatures-athenaeum`'s `src/mcp/server.ts`).

## Errors

```ts
import { AthenaeumApiError } from "@xfeatures/athenaeum-sdk";

try {
  await athenaeum.getFact("secrets", "root-password");
} catch (error) {
  if (error instanceof AthenaeumApiError) {
    console.error(error.code, error.message, error.requestId);
  }
}
```

## Build & test

```bash
npm run build
npm test   # node --test, mocked fetch -- no network calls
```
