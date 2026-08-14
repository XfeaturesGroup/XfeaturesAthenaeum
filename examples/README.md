# Integration examples

Three runnable-shaped examples, one per connection method documented in [`docs/AGENT-INTEGRATION.md`](../docs/AGENT-INTEGRATION.md):

- `support-agent-worker/` — Cloudflare Worker calling Xfeatures Athenaeum over a Service Binding + RPC
- `external-rest-client/` — a non-Worker client calling the authenticated REST API
- `mcp-client-config/` — an MCP client configuration for connecting to `/mcp`

None of these contain real credentials. `support-agent-worker` reads its RPC key from a Wrangler secret; `external-rest-client` reads Access credentials from environment variables; `mcp-client-config/mcp-config.json` uses `${VAR}`-style placeholders -- whether your specific MCP client expands those from its environment automatically or needs a different mechanism depends on that client; check its docs before assuming the syntax here is literal.
