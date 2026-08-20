# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository, or by contacting the maintainers directly.

Please include:

- what you can do that you should not be able to do,
- the credential or role you started from,
- the requests involved, and
- whether you were able to reach data outside that credential's own permissions.

The last point matters most. This system's central claim is that a fully compromised low-privilege agent — including its valid credential — still cannot read, modify or destroy anything outside its own permission set, and cannot escalate to a stronger identity. A report that breaks that claim is the highest-severity thing we can receive.

## What we consider in scope

- Authentication: token verification, introspection, session handling, credential revocation
- Authorization: the permission model, classification tiers, domain scoping, privilege containment
- Cross-transport parity: anything reachable over REST, Workers RPC or MCP that should not be
- Retrieval: anything that returns content the caller is not cleared for, including via a stale index
- Resource bounds: rate limits, daily quotas, upload limits, unbounded work an attacker can force
- Audit integrity: anything that lets an actor act without a truthful audit record

## What we already know

Some properties are deliberate and documented rather than defects:

- **Revocation is not instantaneous.** A positive token introspection is cached for at most 60 seconds, so revoking a principal takes effect within that window rather than immediately. This is a deliberate trade-off, tested, and documented.
- **Authorization denials on read paths are reported as `NOT_FOUND`.** This is intentional: a `FORBIDDEN` would confirm that a resource you may not see exists.
- **Documents above 4 MB may index incompletely.** The upload limit currently exceeds the indexer's limit, so a very large document can be indexed in part. Retrieval still re-checks every hit against the live row, so this affects completeness, not access control.

See [SECURITY-ASSUMPTIONS.md](docs/SECURITY-ASSUMPTIONS.md) for the full list of things the guarantees depend on. A report that one of those assumptions does not hold in a given deployment is valuable and in scope.

## Our own review

This codebase has been through an internal adversarial review. Every finding has a
regression test, and each of those tests was verified to fail against the
vulnerable code first — a test that passes both before and after a fix proves
nothing.

The review is thorough but self-conducted. It is not a substitute for an
independent penetration test, and it is not a claim that no defects remain.
