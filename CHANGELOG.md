# Changelog

Notable changes to Xfeatures Athenaeum. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
