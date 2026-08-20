# Local development

## Prerequisites

- Node.js 20+ and npm
- A Cloudflare account on Workers Paid — D1, R2, Queues, Workflows, AI Search and
  Workers Rate Limiting all require it
- `wrangler`, which is a dev dependency here; no global install needed

```bash
npm install
```

## Running it

```bash
cp .dev.vars.example .dev.vars     # then fill in RPC_KEY_PEPPER
npm run db:migrations:apply:local
npm run db:seed:local
npm run dev
```

`RPC_KEY_PEPPER` can be any 256-bit random value — `openssl rand -hex 32`.
`.dev.vars` is git-ignored; `.dev.vars.example` documents the shape without values.

The seed (`seed/dev-seed.sql`) creates roles, permissions and a couple of synthetic
fixtures. It contains no real data.

## The one thing that needs the cloud

AI Search has no local simulator. `wrangler dev` proxies that binding to a real
instance, so search requests fail with `DEPENDENCY_UNAVAILABLE` until you have
created one (see [DEPLOYMENT.md](DEPLOYMENT.md)). Everything else — facts,
documents, catalog, admin, trash, versioning — works locally without it.

## Tests

```bash
npm run typecheck
npm run lint
npm test
```

Tests run inside the real `workerd` runtime through
`@cloudflare/vitest-pool-workers`, against
[`wrangler.test.jsonc`](../wrangler.test.jsonc) — identical to `wrangler.jsonc`
except that the AI Search binding is omitted, since no test exercises it directly
and it cannot be simulated. Integration tests apply the real migrations to a
Miniflare-backed D1 instance per run.

There is no filesystem in that runtime, so tests that need to read a source file
for structural assertions import it with `?raw`.

### Tests that inspect the source

Some tests read the codebase rather than call it, and fail the build on a
structural regression rather than a behavioural one — an admin route added without
a permission gate, a handler that parses a request body before authenticating, a
new route missing from the quota classification. They exist because those mistakes
are individually easy to make and individually catastrophic, and a normal test only
catches the ones somebody thought to write a case for.

If one fails, the fix is nearly always to satisfy it rather than to amend it.

## Migrations

```bash
npm run db:migrations:apply:local
```

Migrations are append-only. An already-applied migration is history: editing one
makes a fresh database and a deployed one diverge silently. Add a new file instead.

Note that D1 does not honour `PRAGMA foreign_keys = OFF` inside a migration, so the
usual SQLite "rebuild the table to change a constraint" recipe will cascade through
foreign keys and delete dependent rows. Prefer `ALTER TABLE ... ADD COLUMN`.
