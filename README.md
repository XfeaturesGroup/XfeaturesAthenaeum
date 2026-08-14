# Xfeatures Athenaeum

A single authenticated knowledge and retrieval service for every internal AI agent in an organisation. Structured facts live in D1, documents in R2, semantic retrieval runs through Cloudflare AI Search — and no agent ever talks to any of those directly.

Agents speak **REST**, **Workers RPC**, or **MCP**. Athenaeum resolves who is asking and what they are allowed to see on every single call.

```
Agent ──▶ REST / RPC / MCP ──▶ authenticate ▸ authorize ▸ audit ──▶ D1 · R2 · AI Search
```

## Why it exists

Giving each agent its own database, its own copy of the docs, and its own hand-rolled RAG pipeline produces one knowledge base per agent, each stale in a different way, none of them access-controlled. Athenaeum is the alternative: one corpus, one permission model, one audit trail, and per-agent slices of it.

## What it guarantees

- **Identity is never client-claimed.** A caller presents a credential; permissions come from Athenaeum's own database, keyed on the verified identity. Manipulating a token's scope gains nothing.
- **Classification and domain are enforced on every call.** A support agent that can read `support` documents at `INTERNAL` cannot see a `RESTRICTED` one filed under the same domain — and never learns it exists.
- **The search index is not authoritative.** Every retrieved chunk is re-validated against the live database row before it is returned, so a stale or tampered index cannot release content.
- **Retrieved knowledge is evidence, not instruction.** Athenaeum never calls an LLM. It returns passages with citations; the calling agent synthesises the answer and is responsible for treating that content as untrusted.
- **Publishing needs a human.** An agent can draft a document and submit it for review. No transport exposes a way to publish one.

## Documentation

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit together, and why |
| [SECURITY.md](docs/SECURITY.md) | Threat model and security posture |
| [SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) | Adversarial review: every finding, fix and regression test |
| [SECURITY-ASSUMPTIONS.md](docs/SECURITY-ASSUMPTIONS.md) | What the guarantees depend on, stated explicitly |
| [AGENT-INTEGRATION.md](docs/AGENT-INTEGRATION.md) | Connecting an agent over RPC, REST or MCP |
| [openapi.yaml](docs/openapi.yaml) | Full REST surface (checked against the route table in CI) |
| [PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md) | Release gate list |
| [PRODUCTION-MIGRATION-PLAN.md](docs/PRODUCTION-MIGRATION-PLAN.md) | Standing up a new environment |

Client packages live in [`packages/`](packages): [`athenaeum-types`](packages/athenaeum-types), [`athenaeum-sdk`](packages/athenaeum-sdk), [`athenaeum-cli`](packages/athenaeum-cli).


## Prerequisites

- Node.js 20+, npm
- A Cloudflare account with Workers Paid (D1, R2, Queues, Workflows, AI Search, and Workers Rate Limiting all require it)
- `wrangler` (installed as a dev dependency — no global install needed)

```bash
npm install
```

## Infrastructure setup

Every resource name below is `*-dev`; repeat with `-staging`/`-production` and update the matching `env.staging`/`env.production` block in [`wrangler.jsonc`](wrangler.jsonc). Bindings are not inherited across environments, so each block is self-contained.

1. **D1 database**
   ```bash
   npx wrangler d1 create knowledge-core-db-dev
   ```
   Copy the returned `database_id` into `d1_databases[0].database_id` in `wrangler.jsonc`.

2. **R2 bucket** (canonical document storage)
   ```bash
   npx wrangler r2 bucket create knowledge-core-documents-dev
   ```

3. **Queues** (ingestion + dead-letter)
   ```bash
   npx wrangler queues create knowledge-core-ingestion-dev
   npx wrangler queues create knowledge-core-ingestion-dlq-dev
   ```

4. **AI Search instance**, pointed at the R2 bucket from step 2. AI Search needs its own API token — `wrangler ai-search create` will tell you to mint one at `https://dash.cloudflare.com/<account-id>/ai/ai-search/tokens` the first time you run it; create the token there, then re-run the command:
   ```bash
   npx wrangler ai-search create knowledge-core-dev \
     --type r2 \
     --source knowledge-core-documents-dev \
     --prefix "knowledge/" \
     --hybrid-search \
     --reranking \
     --score-threshold 0.4 \
     --max-num-results 25 \
     --custom-metadata document_id:text \
     --custom-metadata classification:text \
     --custom-metadata domain:text \
     --custom-metadata title:text \
     --custom-metadata version:number \
     --custom-metadata language:text \
     --custom-metadata status:text \
     --custom-metadata updated_at:datetime
   ```
   The `--custom-metadata` fields must match `DocumentR2Metadata` in [`src/storage/r2.ts`](src/storage/r2.ts) and `METADATA_KEYS` in [`src/search/ai-search.ts`](src/search/ai-search.ts) exactly — that's the contract retrieval filtering depends on.

5. **Workflow and Rate Limiting bindings** need no separate creation step — `wrangler deploy`/`wrangler dev` provisions them from the `workflows`/`ratelimits` blocks already in `wrangler.jsonc`.

6. **Secrets** (never written to `wrangler.jsonc`):
   ```bash
   npx wrangler secret put RPC_KEY_PEPPER --env development   # or staging / production
   ```
   Generate a value with `openssl rand -hex 32` (or any 256-bit-plus random source). For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and fill it in instead — `.dev.vars` is git-ignored.

7. **Cloudflare Access** (for external/non-Worker callers over REST or MCP): create an Access application in front of the Worker's public hostname, add a Service Auth policy, and note the application's AUD tag and your team domain — set `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` as `vars` per environment. Internal Worker-to-Worker callers (Service Bindings/RPC) don't need Access at all — see [`docs/AGENT-INTEGRATION.md`](docs/AGENT-INTEGRATION.md).

## Database migrations

```bash
npm run db:migrations:apply:local        # local dev (Miniflare-simulated D1)
npm run db:migrations:apply:staging      # real remote D1, staging
npm run db:migrations:apply:production   # real remote D1, production
```

Seed roles/permissions and a couple of synthetic fixtures for local development (no real company data — see `seed/dev-seed.sql`):

```bash
npm run db:seed:local
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in RPC_KEY_PEPPER
npm run db:migrations.apply:local
npm run db:seed:local
npm run dev
```

`wrangler dev` proxies the AI Search binding to your real instance even locally (it has no local simulator) — steps 1–4 above must be done first, or search requests will fail with `DEPENDENCY_UNAVAILABLE` (everything else — facts, documents, products, plans, policies, admin — works without it).

## Testing, linting, typechecking

```bash
npm run typecheck
npm run lint
npm test
```

Tests run inside the real Workers runtime via `@cloudflare/vitest-pool-workers`, against [`wrangler.test.jsonc`](wrangler.test.jsonc) — identical to `wrangler.jsonc` except the AI Search binding is omitted, since no test exercises it directly and it can't be simulated locally. Integration tests apply the real migration to a Miniflare-backed D1 instance per run.

## Deployment

```bash
npm run deploy:staging
npm run deploy:production
```

Deploy to staging first, always. There is no scripted promotion path from staging to production — that's intentional (no accidental staging→production binding).

Before deploying anywhere new, read [`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md) — the gate list, including the one remaining blocker that needs a dashboard-minted credential — and [`docs/PRODUCTION-MIGRATION-PLAN.md`](docs/PRODUCTION-MIGRATION-PLAN.md) for the sequenced procedure across Athenaeum, Account and HQ. Nothing in either has been executed; only development exists today.

## Adding an agent

Only through the admin API — never by inserting rows into `agents` directly, so the RPC key is generated and hashed server-side and shown to you exactly once:

```bash
curl -X POST https://<worker-host>/v1/admin/agents \
  -H "Cf-Access-Jwt-Assertion: <your admin Access JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_key": "support-prod",
    "name": "Support Agent (production)",
    "environment": "production",
    "auth_mode": "rpc",
    "roles": ["support-agent"]
  }'
```

The response's `rpc_key` field is shown once. Store it as that agent Worker's own secret (`wrangler secret put AGENT_RPC_KEY`) — never in this repo, never in D1 in plaintext.

For an Access-authenticated (external/non-Worker) agent, set `"auth_mode": "access"` and configure that agent's Access service token so its `common_name` exactly matches `agent_key`.

Roles/permissions ship pre-seeded (`public-agent`, `support-agent`, `billing-agent`, `network-agent`, `internal-assistant`, `knowledge-admin` — see `seed/dev-seed.sql` for the full permission grants). Adjust or add roles through `POST /v1/admin/roles` and `POST /v1/admin/permissions`... actually granting/revoking is via the `RolesRepository` today; a dedicated admin route for ad-hoc role editing beyond agent creation is a natural next addition — see "What's not built yet" below.

## Adding facts / uploading documents

```bash
# A deterministic fact
curl -X POST https://<worker-host>/v1/admin/facts \
  -H "Cf-Access-Jwt-Assertion: <admin JWT>" -H "Content-Type: application/json" \
  -d '{"namespace":"plans","key":"pro-monthly","value":{"price_usd":29},"classification":"INTERNAL"}'

# A document (multipart: a `metadata` JSON part + a `file` part)
curl -X POST https://<worker-host>/v1/admin/documents \
  -H "Cf-Access-Jwt-Assertion: <admin JWT>" \
  -F 'metadata={"slug":"refund-policy","title":"Refund Policy","domain":"support","classification":"INTERNAL","language":"en"};type=application/json' \
  -F 'file=@refund-policy.md;type=text/markdown'

# Publish it (or use submit-for-review for the approval workflow -- see docs/ARCHITECTURE.md)
curl -X PATCH https://<worker-host>/v1/admin/documents/<id>/status \
  -H "Cf-Access-Jwt-Assertion: <admin JWT>" -H "Content-Type: application/json" \
  -d '{"status":"active"}'
```

Only `active` documents are ever returned by `getDocument` or `searchKnowledge`.

## Connecting an agent

Three ways in — pick based on where the agent runs. Full detail and code samples in [`docs/AGENT-INTEGRATION.md`](docs/AGENT-INTEGRATION.md); a runnable example of each is in [`examples/`](examples/).

- **Another Cloudflare Worker** → Service Binding + RPC (`examples/support-agent-worker/`)
- **An external server** → authenticated REST (`examples/external-rest-client/`)
- **An MCP-speaking agent/client** → authenticated MCP over Streamable HTTP at `/mcp` (`examples/mcp-client-config/`)

## OpenAPI

[`docs/openapi.yaml`](docs/openapi.yaml) documents the REST surface.

## What's not built yet

Being direct about the edges of this build rather than implying more than is there:

- **PDF ingestion**: intentionally out of scope (see `src/config.ts`) — no verified-safe in-Worker PDF text extraction is wired up. Convert to Markdown/plain text upstream for now.
- **Ad-hoc role/permission editing UI or API beyond what agent creation needs**: roles/permissions are fully modeled in D1 and seeded; a dedicated `POST /v1/admin/roles` / `POST /v1/admin/permissions` CRUD surface for editing them after the fact isn't wired into the router yet (`RolesRepository` has everything the routes would need).
- **Admin listing/detail routes for facts, products, plans, services, and policies** (create/update exist; a paginated "list everything of type X for review" admin view doesn't).
- **A caching layer**: deliberately not built. AI Search's own response cache is explicitly disabled (`cache.enabled: false`, see `src/search/ai-search.ts`) because its cache-key contract with respect to per-agent classification/domain filters isn't documented, and's requirement (never let one agent's cached result leak to a differently-scoped agent) isn't provable without that. Safe to add later once verified.
- **OAuth-based MCP authorization discovery** (`.well-known/oauth-protected-resource` etc.): the MCP endpoint is authenticated the same way REST is (Access JWT), which doesn't need this; the SDK supports it if a future client needs standard OAuth discovery instead.
