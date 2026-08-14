# ADR 0001 — Athenaeum integration with Xfeatures Account and HQ

**Status:** accepted
**Date:** 2026-08-17

## Context

Athenaeum (this repository, formerly "Xfeatures Athenaeum") is the knowledge and retrieval layer for the Xfeatures ecosystem. Two systems already exist and must not be rebuilt:

**Xfeatures Account** (`XfeaturesAccount/xfeatures-auth-api`) — Cloudflare Worker, `itty-router`, D1, R2. It is the ecosystem IAM:
- Human authentication: session cookies (`session_id`, SHA-256 hashed at rest in `sessions`), PBKDF2-SHA512 passwords, TOTP, WebAuthn passkeys.
- HQ staff authorization: `users.role` (`admin` | `moderator`) plus a `users.permissions` JSON array, enforced by `requireAdmin` / `requirePermission('area:verb')`.
- A full OAuth 2.0 provider: `authorization_code` with mandatory PKCE-S256, and `refresh_token` with rotation (`prev_refresh_hash`). Applications live in `oauth_applications` (`client_id` = `xf_<hex>`, `client_secret_hash` = SHA-256), tokens in `oauth_tokens` (access token stored hashed), consent in `oauth_grants`, per-app scope allowlist in `allowed_scopes`, trust flags `is_official` / `is_verified` / `require_2fa`, ownership by user or team.
- Endpoints: `POST /oauth/token`, `GET /oauth/userinfo`. Audit into `audit_logs`.

**HQ** (`XfeaturesAccount/xfeatures-hq-api` + `xfeatures-hq-web`) — the administrative control plane. `hq-api` is a separate Worker (`itty-router`, D1, R2). `hq-web` is React 19 + Vite + Tailwind + Zustand + axios (`withCredentials`), routed with `react-router-dom`, pages grouped by category folder, gated by `<PermissionGate permission={PERMISSIONS.X}>`, styled with an existing glass/liquid design system (`components/ui/{Button,GlassPanel,Input,Modal,LiquidBackground}`). `react-markdown` + `remark-gfm` are already dependencies.

Athenaeum currently authenticates two principal kinds: Cloudflare Access service tokens (external HTTP) and per-agent RPC credentials (internal Workers). Neither is connected to Xfeatures Account.

## Decision

### 1. Xfeatures Account remains the only identity provider. Athenaeum becomes an OAuth 2.0 resource server.

No second human authentication system is built inside Athenaeum. Two additions are made to `xfeatures-auth-api`:

- **`client_credentials` grant.** Machine principals (Discord bots, network agents, documentation agents) have no user, so neither existing grant fits. This is the standard M2M flow and reuses the existing `oauth_applications` client id/secret pair and `allowed_scopes` allowlist verbatim.
- **`POST /oauth/introspect` (RFC 7662).** Athenaeum needs to turn a bearer token into a verified identity. `GET /oauth/userinfo` is unsuitable: it is user-centric, returns no `client_id`, and returns nothing for a `client_credentials` token. Introspection returns `{active, client_id, sub, scope, exp, token_type}` and is itself client-authenticated.

### 2. Knowledge permissions stay in Athenaeum. Xfeatures Account asserts identity only.

Athenaeum's permission vocabulary is fine-grained (`documents.read.<domain>`, `facts.read.<namespace>`, `knowledge.classification.<TIER>`, `admin.*`) and classification-aware. Pushing several dozen knowledge scopes into the ecosystem-wide OAuth scope registry would pollute IAM, duplicate authorization state in two databases, and create a drift/consistency problem on every permission change.

Instead:
- Xfeatures Account gains **one coarse scope, `athenaeum`**, meaning "this principal may reach Athenaeum at all".
- Athenaeum's `agents` table is the authority for *what* a principal may see, linked to the Account identity by `account_client_id` (applications) or `account_user_id` (humans).
- HQ manages those knowledge permissions **through Athenaeum's administrative API**, not by writing to Athenaeum's database.

This keeps the entire authorization engine, classification model, and 241-test security baseline unchanged: `authorize()` still reads only from a `Principal` resolved out of Athenaeum's own D1. The new code path only changes how the *identity* at the front of that resolution is established.

### 3. Introspection over HTTPS, not a Service Binding — for now.

A Cloudflare Service Binding (Athenaeum → auth-api `WorkerEntrypoint`) would avoid a network hop. It also couples the two Workers' deployments. Both products are currently independently deployable and the existing repositories are separate; keeping that property (and keeping the integration a documented standard protocol) is worth one sub-request. Introspection responses are cached per-token for the token's remaining lifetime, bounded to 60s, so the hop is amortized.

A Service Binding fast path can be added later without changing any caller, because introspection sits behind the `AccountTokenVerifier` interface.

### 4. Responsibility split

```
Xfeatures Account  = identity, applications, credentials, consent, revocation
HQ                 = administrative control plane (a CLIENT of Athenaeum)
Athenaeum          = knowledge storage, retrieval, and policy enforcement
```

HQ is never trusted because it is official Xfeatures software. Every HQ action reaches Athenaeum over its authenticated administrative API and is authorized server-side by Athenaeum. HQ holds no Athenaeum database access.

### 5. Principal model

Athenaeum recognises four conceptual principal types, mapped onto what Xfeatures Account actually has:

| Athenaeum principal | Xfeatures Account reality | Token path |
|---|---|---|
| `APPLICATION` | `oauth_applications` row | `client_credentials` → introspect |
| `USER` | `users` row with an HQ session | `authorization_code` → introspect (`sub`) |
| `SERVICE` | internal Cloudflare Worker | existing RPC credential |
| `AI_AGENT` | an `oauth_applications` row, conventionally | `client_credentials` → introspect |

`AI_AGENT` is not a distinct Account entity — an AI agent is an application that happens to be driven by a model. Modelling it as anything else would duplicate the application lifecycle (issue/rotate/revoke) for no benefit.

### 6. Nothing client-supplied is ever authority

`user_id`, `account_id`, `application_id`, `agent_id`, `role`, `permissions`, and `classification` are never read from a request body, header, or query parameter as authority. Identity comes from the introspected token (`client_id` / `sub`); permissions come from Athenaeum's D1 keyed by that identity.

### 7. Repository organisation

Athenaeum keeps its own repository. HQ and Xfeatures Account are **not** merged into it. Shared surface is published as packages (`@xfeatures/athenaeum-sdk`, `-types`, `-cli`, `-mcp`) consumed by HQ rather than by copying source. The two additive changes to `xfeatures-auth-api` are backwards compatible: no existing grant, endpoint, table, or scope changes behaviour.

## Consequences

**Positive.** One identity system. Per-application credentials that are independently revocable through machinery that already exists (rotate secret, suspend app, delete app). No duplicated permission state. The security baseline is preserved unchanged. Both existing products stay independently deployable.

**Negative / accepted.** Athenaeum takes a runtime dependency on `xfeatures-auth-api` availability for HTTP principals — mitigated by bounded per-token caching and by the fact that internal Worker RPC and Cloudflare Access paths remain independent. Introspection adds one sub-request to a cold token.

**Rejected alternatives.** (a) Mirroring Athenaeum permissions into OAuth scopes — duplicated authority, drift. (b) Athenaeum reading Account's D1 directly — cross-product database coupling, breaks the trust boundary. (c) A shared static API token for all applications — explicitly forbidden by the security baseline (no `all-agents-admin-token`). (d) A second login system in Athenaeum — forbidden by the brief.
