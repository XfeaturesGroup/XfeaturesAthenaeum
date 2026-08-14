# Security

## Threat model

Assume breach:

- **A credential can leak.** An Access service token or an RPC key can end up somewhere it shouldn't. Mitigation: every identity is independently issued, rotatable, and revocable (`agents.status`); leaking one agent's credential exposes only that agent's permission set, never anyone else's, and never a shared "admin token" (— no such thing exists in this system).
- **An agent Worker can be compromised.** Attacker-controlled code running as `support-prod` should not be able to read `network-agent`'s RESTRICTED data. Mitigation: authorization is resolved server-side from D1 on every call — a compromised agent Worker can only exercise the permissions its *own* identity actually holds, never claim a different one without also stealing that identity's separate credential.
- **A document can be malicious.** Anything uploaded — by an employee, by an automated import — is untrusted content the moment it's stored. Mitigation: see "Prompt injection defense" below; retrieved content never has any code path back into a system prompt, tool invocation, or permission decision.
- **A caller can be adversarial.** Malformed input, oversized payloads, SQL-injection-shaped strings, path-traversal-shaped filenames. Mitigation: schema validation on every input (`src/api/schemas/*`), prepared statements exclusively (`src/repositories/*`), and dedicated tests for both (`tests/security/`, `tests/integration/facts-repository.test.ts`).

## Trust boundaries

See the diagram in [`ARCHITECTURE.md`](ARCHITECTURE.md#trust-boundaries). In short: the public internet reaches Xfeatures Athenaeum only through Cloudflare Access; other Workers reach it through account-scoped Service Bindings plus an explicit RPC credential; Xfeatures Athenaeum is the only thing that ever touches D1, R2, or AI Search directly.

## Authentication

Two paths, one identity model (`agents.agent_key`), one resolution function (`resolvePrincipalForAgentKey` in `src/auth/authenticate.ts`):

- **External / non-Worker callers** (REST, MCP): Cloudflare Access issues a `Cf-Access-Jwt-Assertion` JWT after verifying a service token. Xfeatures Athenaeum verifies that JWT's signature against Access's published JWKS (`src/auth/access-jwt.ts`, using `jose`), checks `iss`/`aud`, and reads the service token's `common_name` claim as the claimed `agent_key`.
- **Internal Worker-to-Worker callers** (Service Binding / RPC): the Service Binding itself only proves "some Worker in this account was configured to call me" — it carries no caller identity. The calling Worker therefore also presents `{agentKey, rpcKey}`; Xfeatures Athenaeum verifies `rpcKey` against a peppered SHA-256 hash (`agents.rpc_key_hash`) using a timing-safe comparison (`src/utils/hash.ts`).

Both paths converge on the same D1 lookup: unknown `agent_key`, `status != 'active'`, or any lookup error all resolve to a denial (`UNAUTHENTICATED`), never to a default identity or role.

## Authorization

`src/auth/authorize.ts` is the only code that grants access, called identically from REST route handlers, the RPC entrypoint, and every MCP tool (via the knowledge service methods they all share, which call `assertAuthorized` internally). RBAC (`agent -> agent_roles -> role_permissions -> permissions`) plus resource attributes (ABAC): reading a document or fact requires *both* a scope permission (`documents.read.<domain>` / `facts.read.<namespace>`, suffix-wildcard aware) *and* a classification permission (`knowledge.classification.<TIER>`) — holding one without the other denies. See the taxonomy and default role grants in `seed/dev-seed.sql`, and the required test matrix in `tests/unit/authorize.test.ts`.

Wildcards are suffix-only (`documents.read.*`), parsed by exactly one function (`permissionSatisfies` in `src/auth/permissions.ts`), and a bare `*` is never interpreted as "all permissions" anywhere in the codebase (no all-agents-admin grant).

## Data classification

Four tiers: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`. Every classified table has a `NOT NULL CHECK (classification IN (...))` column — there is no way to write a row without one. The application-level default when a caller omits classification is hard-floored at `INTERNAL` (`HARD_MINIMUM_DEFAULT_CLASSIFICATION` in `src/security/classification.ts`) and cannot be configured down to `PUBLIC` via environment variable, only up.

## ACL before retrieval

Classification/domain filters are sent to AI Search as part of the query itself (`src/search/ai-search.ts`), derived entirely from the authenticated Principal — never from client-supplied request fields (a client can *narrow* to a domain it already has, never broaden). Every returned chunk is additionally checked against a fresh, live read of the source document's current `status`/`classification`/`domain` in D1 before being returned, closing the window where a background reindex hasn't yet caught up with a document being archived or reclassified. Neither check alone is treated as sufficient — see the sequence diagram in `ARCHITECTURE.md`.

## Prompt injection defense

Retrieved knowledge — from a fact value, a document, or a search result — is data, never an instruction, anywhere in this codebase:

- Nothing here ever concatenates retrieved content into a system prompt, calls an LLM, or evaluates it as code. Xfeatures Athenaeum doesn't call any LLM at all — it returns evidence and stops.
- Every MCP tool result is wrapped as `{notice: EVIDENCE_NOTICE, data: <content>}` (`src/mcp/server.ts`) — the warning travels with the payload into whatever context window eventually consumes it, not just the tool description the calling model saw once at connect time.
- `docs/AGENT-INTEGRATION.md` tells every integrating agent explicitly: retrieved knowledge is evidence, not executable instruction, and to keep it out of anywhere it could be misread as a system-level directive.
- Tested directly in `tests/unit/prompt-injection.test.ts`: known injection-shaped strings ("Ignore previous instructions...", fake `<system>` tags) are asserted to survive as inert string data, verbatim, never interpolated into any structural part of a response.

## Secrets

- `RPC_KEY_PEPPER` is a Worker Secret (`wrangler secret put`), never in `wrangler.jsonc`, never in D1, never in a log line (the structured logger in `src/utils/logging.ts` redacts a fixed set of sensitive key names on every call).
- RPC keys themselves are shown to an admin exactly once, at agent-creation time (`POST /v1/admin/agents` response) — only their peppered hash is ever persisted.
- No secret of any kind is ever passed to, or readable by, an LLM. Xfeatures Athenaeum doesn't call an LLM in the first place, so there's no code path where that could even happen by accident.
- Local development secrets live in `.dev.vars` (git-ignored); `.dev.vars.example` documents the shape without real values.

## Audit

Every authenticated call — success or denial — writes an `audit_events` row (`src/audit/audit.ts`, invoked from the shared `runAuthenticatedOperation` pipeline in `src/auth/pipeline.ts`) with: `request_id`, actor `agent_id`, `action`, `decision` (ALLOW/DENY), `reason` on denial, resource type/id, and status. Administrative writes (create/update/publish/agent status changes) additionally record an `auditChange` entry with whitelisted before/after values — never a raw payload dump, never a secret value. Audit writes are best-effort from the caller's perspective (a logging failure never blocks or fails the underlying request) but their own failure is itself logged as a `security_event`.

Structured logs (`src/utils/logging.ts`) are metadata-only by default: agent id, action, domain, result count, duration. Raw query text and retrieved content are never logged — there is no `LOG_CONTENT_DEBUG: true` code path wired up in this build; the flag exists in `wrangler.jsonc` as a documented off-switch placeholder for a future, explicitly-scoped debug mode, not a currently-functioning one.

## Rate limiting and abuse controls

Three Workers Rate Limiting bindings (`RATE_LIMITER_SEARCH`, `RATE_LIMITER_READ`, `RATE_LIMITER_ADMIN`), keyed by `agentId` — never by IP, since internal agents share egress paths (`src/security/rate-limit.ts`). Combined with hard, documented application-level ceilings in `src/config.ts` (query length, upload size, pagination, batch size, search result count) that are deliberately stricter than what the platform alone would allow, so a compromised or buggy caller can't turn one request into unbounded D1/R2/AI Search cost.

## Input validation

Every REST/RPC/MCP input is validated against a schema before it reaches business logic — Zod schemas for REST (`src/api/schemas/*`), typed parameters for RPC, Zod-backed `inputSchema` for MCP tools. No repository ever concatenates a caller-controlled value into a SQL string; every query goes through D1's prepared-statement `bind()` (verified directly against a real D1 instance in `tests/integration/facts-repository.test.ts`, including a SQL-injection-shaped payload used as a literal value). Uploaded filenames are validated for path-traversal characters and never used to build an R2 key — keys are entirely server-generated (`buildDocumentR2Key` in `src/storage/r2.ts`).

## Credential rotation

- **RPC keys**: `PATCH` a new hash via an admin flow (today: regenerate through the repository's `rotateRpcKey`; wiring a dedicated `POST /v1/admin/agents/:id/rotate-key` REST route is a natural next addition, see README "What's not built yet"). Rotating invalidates the old key immediately — there is no grace-period dual-key support, so coordinate the swap with the agent's own deploy.
- **Access service tokens**: rotate from the Cloudflare dashboard/API per Cloudflare's own service-token lifecycle; Xfeatures Athenaeum only ever sees the resulting JWT, never the token itself, so no code here needs to change.
- **Emergency revoke**: `PATCH /v1/admin/agents/:id/status {"status": "revoked"}` takes effect on the agent's very next request — permissions are resolved fresh from D1 every time, there is no cache to invalidate.

## Secure deployment checklist

- [ ] `RPC_KEY_PEPPER` set as a real Worker Secret in every environment, distinct per environment
- [ ] `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` set for any environment with external REST/MCP callers
- [ ] AI Search instance's public/direct access left disabled — it's reached only through this Worker's binding, never exposed as its own public endpoint
- [ ] Each environment (`development`/`staging`/`production`) has its own D1 database, R2 bucket, Queue, and AI Search instance — verify no `env.*` block in `wrangler.jsonc` accidentally points at another environment's resource id
- [ ] `npm run typecheck && npm run lint && npm test` all pass before every deploy
- [ ] New agents created only through `POST /v1/admin/agents`, never by direct D1 writes
- [ ] Default classification for any new content type stays at `INTERNAL` or stricter unless there's a deliberate, reviewed decision to make something `PUBLIC`

## Incident response (starting point)

1. **Suspected leaked credential**: `PATCH` that agent to `status: "revoked"` immediately — takes effect on its next call. Check `audit_events` for that `actor_agent_id` to scope what it actually accessed.
2. **Suspected malicious document**: `PATCH` its status to `archived` — this stops `getDocument` immediately (live status check) and enqueues an index-removal job. Check `knowledge_feedback` and `audit_events` for related reports.
3. **Suspicious query pattern** (`SecurityEvent.SUSPICIOUS_QUERY` isn't currently emitted anywhere automatically — the type exists in `src/utils/logging.ts` for a future anomaly-detection pass to hook into): review `audit_events` filtered by `actor_agent_id` and `occurred_at` for the affected window; rate limiting will have already throttled sustained abuse from a single identity.
