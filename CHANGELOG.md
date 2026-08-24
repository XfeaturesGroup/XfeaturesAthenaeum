# Changelog

Notable changes to Xfeatures Athenaeum. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The ingestion and audit listings answered with the raw database row.** Both
  named every field the way SQLite does (`document_id`, `occurred_at`,
  `attempt_count`) while every other endpoint in this API answers in camelCase,
  so a client asking for the documented names got `undefined` in every column.
  Both now project through `OperationsService` into `IngestionJobDTO` /
  `AuditEventDTO`.
- **The administrative fact writes answered with the raw database row** --
  `value_json` as a string, the internal id, `created_by` -- while every read
  path answered with the fact DTO, so a client had to handle two shapes
  depending on which verb it used. Both now project through `toFactDTO`.
- **Ingestion rows carry the document's title and slug.** A listing of bare ids
  cannot tell an operator which document is stuck. The join is a LEFT join: a
  job outlives the document it indexed, and dropping those rows would erase the
  evidence that anything was ever indexed for it.

### Added

- **A trash for facts** (migration `0005`), on exactly the model documents have
  had since `0003`. Deprecating a fact keeps it and every version forever, which
  is right for a superseded price and wrong for something that should never have
  been filed at all. A trashed fact stops answering immediately on every
  transport, is restorable to the state it was in for the retention window, and
  is then destroyed with its history by the same scheduled purge. There is no
  manual permanent delete, here or anywhere else.
- **`GET /v1/facts`** — the namespaces a caller can read, with counts. Both are
  projections of the caller's permissions: an unreadable namespace does not
  appear at all, and a count covers only rows the caller may see.
- **`GET /v1/admin/facts`** — facts across namespaces, with `namespace`,
  `status` and free-text `q` filters. `admin.facts` makes the listing reachable;
  every row is still authorized individually, and `namespace` can only narrow
  the caller's own scope.
- **`GET /v1/admin/facts/{namespace}/{key}/versions`** — a fact's history with
  the value each version held, authorized against every version's own
  classification rather than only the current one.
- Server-side filtering on both listings: `status` for ingestion; `action`,
  `decision` and `actor_agent_id` for audit. Hunting a refusal no longer means
  paging through grants to find it.

### Security

- **`actor_identity_raw` is no longer projected into audit responses.** The
  column holds the unprocessed identity string a caller presented and exists
  for forensics against the database; the raw-row response handed it to every
  reader of the audit trail.
- The audit DTO keeps `N/A` distinct from `ALLOW`. It records an attempt that
  no authorization decision was ever made about, and any client testing "not
  DENY" reports those as permitted — in the one view whose purpose is to say
  what was permitted.

## [0.1.0]

First production release.

### Added

- **Knowledge service** over Cloudflare Workers: structured facts in D1, documents
  in R2, semantic retrieval through AI Search, plus a product/plan/service/policy
  catalog.
- **Three transports, one pipeline.** REST, Workers RPC and MCP (Streamable HTTP,
  stateless) all run the same authenticate → authorize → audit path.
- **Identity through Xfeatures Account.** Bearer tokens verified by introspection
  (RFC 7662), gated on the `athenaeum` scope for services, or on a single
  pre-registered Developer Access application for interactive use. Cloudflare Access
  JWTs and Worker-to-Worker RPC credentials remain supported.
- **RBAC with classification tiers and domain scoping.** Reading anything requires
  both a scope permission and a classification permission; holding one without the
  other denies.
- **Retrieval that does not trust its own index.** Classification and domain filters
  are pushed into the search query, and every returned chunk is re-validated against
  a live database read — including that the chunk belongs to the document's *current*
  version, so a superseded version cannot be served under the current one's identity.
- **Human-gated publishing.** Agents may draft and submit for review. No transport
  exposes a publish operation.
- **Immutable document versions** with edit, version history and rollback. Editing
  writes a new version; rollback republishes an earlier one as a new version. History
  is never rewritten in place.
- **Trash lifecycle.** Documents move to trash and leave every retrieval surface
  immediately; they are restorable for 72 hours to their previous state; a scheduled
  job purges canonical content and historical objects after the window, leaving the
  audit trail intact. There is no manual permanent-delete anywhere.
- **Audit on every authenticated call**, allow or deny, with whitelisted before and
  after values on administrative writes — never a raw payload dump.
- **Per-identity rate limiting and quotas**, plus hard application ceilings on query
  length, upload size, pagination and result count.
- **Client packages**: `@xfeaturesgroup/athenaeum` and
  the `athenaeum` CLI, which implements the PKCE login flow.
- **Source-inspection tests** that fail the build on structural regressions: an
  admin route without a permission gate, a handler parsing a body before
  authenticating, a route missing from quota classification, an agent principal from
  the wrong environment.

### Security

- All findings from an internal adversarial review are fixed, each with a regression
  test verified to fail against the vulnerable code first.
- Read denials return `404` rather than `403`, so a denial cannot confirm that a
  resource exists.
- Positive token introspection is cached for at most 60 seconds; negative results are
  never cached.
- An agent's `environment` must equal the Worker's own, so a credential from one
  environment cannot authenticate against another.
