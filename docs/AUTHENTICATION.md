# Authentication

Athenaeum answers three transports — REST, Workers RPC and MCP — and every one of
them goes through the same code (`src/auth/pipeline.ts`). There is no looser path
for MCP, and none for "internal" callers. What changes between transports is only
how a credential is presented.

## Which credential do I need?

```mermaid
flowchart TD
    start["What is calling Athenaeum?"] --> human{"A person, at a terminal<br/>or in a browser?"}
    human -- yes --> pkce["Authorization Code + PKCE<br/>through Xfeatures Account<br/>(docs/OAUTH-PKCE.md)"]
    human -- no --> worker{"Another Worker in the<br/>same Cloudflare account?"}
    worker -- yes --> rpc["Service Binding + RPC credential<br/>{agentKey, rpcKey}"]
    worker -- no --> cc["client_credentials<br/>through Xfeatures Account<br/>(docs/OAUTH-CLIENT-CREDENTIALS.md)"]
```

## The two things a credential must prove

Authentication answers *who is calling*. It never answers *what they may see* —
that is resolved separately, from Athenaeum's own database, on every single call.
A token cannot carry its own permissions, so editing one gains nothing.

Concretely, an Account token must clear two gates before Athenaeum will even look
up a principal:

1. **The ecosystem gate.** The token carries the `athenaeum` scope. This is coarse
   and grants no knowledge access by itself; lacking it means the caller was never
   meant to reach Athenaeum at all. Account only ever unions this scope into a
   token through the `client_credentials` grant, which is restricted to
   applications registered as `app_type: "service"`.
2. **The Athenaeum principal.** The introspected `client_id` (or, for a
   user-delegated token, the subject) must match an `agents` row that is `active`.
   Unknown, disabled or revoked all resolve to `UNAUTHENTICATED`.

Because a human's own Account login can never carry the `athenaeum` scope — the
grant that produces it has no consent screen and no subject — interactive access
goes through one narrower door instead: a token from the single pre-registered
**Athenaeum Developer Access** application, carrying a subject. Every other
application, no matter who owns it, still needs the scope.

## Discovery

Athenaeum publishes RFC 9728 protected-resource metadata, so a client can find its
authorization server without being told:

```bash
curl https://athenaeum.xfeatures.net/.well-known/oauth-protected-resource
```

```json
{
  "resource": "https://athenaeum.xfeatures.net",
  "authorization_servers": ["https://auth.xfeatures.net"],
  "bearer_methods_supported": ["header"]
}
```

## Presenting a token

Bearer, in the header. Query-string tokens are not accepted — they end up in logs
and referrers.

```bash
curl -H "Authorization: Bearer $TOKEN" \
     https://athenaeum.xfeatures.net/v1/knowledge/search \
     -H 'content-type: application/json' \
     -d '{"query": "refund window"}'
```

## Worker-to-Worker (RPC)

A Service Binding proves only that *some* Worker in the account was configured to
call Athenaeum. It carries no identity, so it is not treated as one. The calling
Worker also presents `{agentKey, rpcKey}`; Athenaeum compares `rpcKey` against a
peppered SHA-256 hash with a timing-safe comparison. The RPC key is shown once, at
agent creation, and only its hash is stored.

## Revocation, and its window

Permissions are read fresh from D1 on every call, so a permission change or an
agent revocation in Athenaeum takes effect on the next request with no cache to
clear.

Account token introspection is different: a *positive* introspection result is
cached for at most 60 seconds. Revoking a principal at Account therefore takes
effect within that window rather than instantly. This is deliberate — introspecting
on every call would make Athenaeum unavailable whenever Account is — and it is
tested and documented rather than accidental. Negative results are never cached, so
an outage cannot pin a legitimate caller into denial.

## What failures look like

| Situation | Response |
|---|---|
| No credential, or one that fails introspection | `401 UNAUTHENTICATED` |
| Valid token, missing the `athenaeum` gate | `401 UNAUTHENTICATED` |
| Valid principal, lacks permission for a **write** | `403 FORBIDDEN` |
| Valid principal, lacks permission for a **read** | `404 NOT_FOUND` |

That last row is intentional. A `403` on a read would confirm that a document you
are not cleared to know about exists. Denials are audited either way.
