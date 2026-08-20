# Integration examples

Runnable-shaped examples for the connection methods documented in [`docs/AGENT-INTEGRATION.md`](../docs/AGENT-INTEGRATION.md):

- `support-agent-worker/` — Cloudflare Worker calling Xfeatures Athenaeum over a Service Binding + RPC
- `external-rest-client/` — a non-Worker client calling the authenticated REST API
- MCP client configurations now live in the [MCP repository](https://github.com/XfeaturesGroup/XfeaturesAthenaeumMCP/tree/main/examples)

None of these contain real credentials. `support-agent-worker` reads its RPC key from a Wrangler secret; `external-rest-client` reads its Account application credentials from environment variables and exchanges them for a short-lived token.
