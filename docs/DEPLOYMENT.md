# Deployment

Every resource below is per-environment. Bindings are not inherited across
environments in `wrangler.jsonc`, so each `env.*` block is self-contained — which is
deliberate: it makes "staging accidentally points at production's database"
impossible to do by omission.

Names here use a `-dev` suffix; repeat with `-staging` / `-production`. They keep
the `knowledge-core-` prefix this project was originally built under — the product
is Athenaeum, but these are live resource identifiers, and renaming a D1 database
or an R2 bucket means creating a new empty one. The names in `wrangler.jsonc` are
the authority; match them.

## 1. D1

```bash
npx wrangler d1 create knowledge-core-db-dev
```

Copy the returned `database_id` into the matching `d1_databases[0].database_id`.

## 2. R2

```bash
npx wrangler r2 bucket create knowledge-core-documents-dev
```

## 3. Queues

```bash
npx wrangler queues create knowledge-core-ingestion-dev
npx wrangler queues create knowledge-core-ingestion-dlq-dev
```

## 4. AI Search

Pointed at the bucket from step 2. AI Search needs its own API token; the first run
of the command below tells you where to mint one.

```bash
npx wrangler ai-search create knowledge-core-dev \
  --type r2 --source knowledge-core-documents-dev --prefix "knowledge/" \
  --hybrid-search --reranking --score-threshold 0.4 --max-num-results 25 \
  --custom-metadata document_id:text \
  --custom-metadata classification:text \
  --custom-metadata domain:text \
  --custom-metadata title:text \
  --custom-metadata version:number \
  --custom-metadata language:text \
  --custom-metadata status:text \
  --custom-metadata updated_at:datetime
```

The `--custom-metadata` fields must match `DocumentR2Metadata` in
[`src/storage/r2.ts`](../src/storage/r2.ts) and `METADATA_KEYS` in
[`src/search/ai-search.ts`](../src/search/ai-search.ts) exactly. That is the
contract retrieval filtering depends on; a mismatch degrades silently into
returning nothing rather than failing loudly.

Leave the instance's own public access disabled. It is reached only through this
Worker's binding.

## 5. Workflows, rate limiting, cron

No separate creation step — `wrangler deploy` provisions these from the
`workflows`, `ratelimits` and `triggers` blocks already in `wrangler.jsonc`.

The cron trigger is what purges expired trash. Without it, trashed documents stay
invisible but are never purged, so confirm it is registered after the first deploy.

## 6. Secrets

```bash
npx wrangler secret put RPC_KEY_PEPPER --env production
npx wrangler secret put AI_SEARCH_API_TOKEN --env production
```

Distinct per environment. Never in `wrangler.jsonc`, never in D1, never in a log
line — the structured logger redacts a fixed set of key names on every call.

## 7. Identity

Athenaeum authenticates callers against Xfeatures Account. Per environment, set:

- `ACCOUNT_INTROSPECTION_URL` — the authorization server's introspection endpoint
- `ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID` — the one application allowed to hold
  interactive, user-delegated access

Each agent's `environment` column must equal the Worker's own `ENVIRONMENT`. A
principal from another environment is refused; this is enforced and tested, and it
is what stops a development credential from working against production.

## 8. Migrate and deploy

```bash
npm run db:migrations:apply:production
npm run deploy:production
```

Staging first, always. There is no scripted promotion path from staging to
production, so there is no accidental one either.

## Before a production deploy

- [ ] `npm run typecheck && npm run lint && npm test` all pass
- [ ] Every `env.*` block verified to point at its own resource ids, not another
      environment's
- [ ] Secrets set, and distinct per environment
- [ ] AI Search instance reachable and not publicly exposed
- [ ] Cron trigger registered
- [ ] Agents created only through `POST /v1/admin/agents`, never by direct D1 writes
- [ ] Default classification for any new content type left at `INTERNAL` or stricter

## Creating an agent

Only through the admin API, so the RPC key is generated and hashed server-side and
shown once:

```bash
curl -X POST https://<host>/v1/admin/agents \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "agent_key": "support-prod",
    "name": "Support Agent (production)",
    "environment": "production",
    "auth_mode": "rpc",
    "roles": ["support-agent"]
  }'
```

Store the returned `rpc_key` as that agent Worker's own secret. It is not
recoverable.
