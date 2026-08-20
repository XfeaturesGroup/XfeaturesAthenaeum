# Contributing

This repository is source-available for reading rather than open source — see
[LICENSE](LICENSE). Pull requests from outside the organisation are generally not
accepted. Security reports are always welcome; see [SECURITY.md](SECURITY.md).

## Before you start

```bash
npm install
npm run verify     # typecheck, lint, OpenAPI contract, full test suite
```

`npm run verify` is what CI runs. If it passes locally it should pass there.

## The rules that are not negotiable

This is an access-control system. A few conventions exist because breaking them has already caused a real vulnerability in this codebase, and each is enforced by a test that fails loudly.

**Every operation declares its authorization.** `runAuthenticatedOperation` takes a required `authorization` field — either `enforce` (the pipeline checks before your handler runs) or `deferred` (your named function checks, because the answer depends on data you must load first). There is no third option and no default. An earlier revision took a free-text `action: string` used only as an audit label; eleven administrative endpoints read as authorized and were reachable by any authenticated caller.

**If you use `deferred`, your enforcer must actually enforce.** A test enumerates every deferred site and checks the named function calls `assertAuthorized`.

**Never compare permission strings directly.** Go through `hasPermission` / `hasAnyPermission`. It is the only code that interprets wildcards, and it deliberately refuses over-broad ones like `admin.*`.

**Every mutating admin route consumes quota.** A test enumerates the handlers and fails if one does not. Rate limiting bounds how fast; quota bounds how much per day. They are not interchangeable.

**Never trust the search index.** Anything retrieved must be re-validated against the live database row before being returned. The index is a hint about where to look, never the authority on what a caller may see.

**Publishing stays human.** No transport may expose a way to publish or approve a document. Drafting and submitting for review are fine.

## Tests

New behaviour needs a test. New *security* behaviour needs a test that has been **verified to fail against the vulnerable code** — write the test, break the guard, watch it fail, restore the guard. A regression test that passes both before and after a fix proves nothing, and this repository has shipped one of those before.

Prefer a structural test over a per-case one where the property is structural. "Every mutating route consumes quota" as a source-inspection check covers routes nobody remembered to write a case for; that is exactly how the gap it now guards appeared.

## Changing the API

`docs/openapi.yaml` is checked against the real route table in CI (`npm run verify:openapi`). Add a route, document it in the same change.

Within `/v1`, fields may be added but never removed or repurposed, and error `code` values are never renamed. A breaking change ships as `/v2`.

## Migrations

Migrations are append-only. Once a migration has been applied anywhere, editing it means the change will never run there. Add a new one.

`npm run schema:verify` (in the Account repository) applies every migration to an empty database and diffs the result against the canonical schema. Run it before deploying schema changes.
