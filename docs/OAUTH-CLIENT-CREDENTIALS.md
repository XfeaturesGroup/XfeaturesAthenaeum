# Service login — client_credentials

This is how a **service** gets an Athenaeum token: a backend, a scheduled job, an
agent that runs without a person present. It follows RFC 6749 §4.4. There is no
user, no consent screen, and no subject on the resulting token.

## Registering the application

In Xfeatures Account, register the application with `app_type: "service"`. Only
service applications may use this grant, and only this grant unions the `athenaeum`
scope into a token — which is precisely why a human's own login can never carry it.

You will be shown a `client_id` and a `client_secret`. The secret is shown once.
Store it as a secret in whatever runs the service (`wrangler secret put`, your
platform's secret manager) — never in source, never in a config file that is
committed.

Then create the matching Athenaeum principal and grant it roles. A registered
Account application with no Athenaeum principal authenticates successfully and can
still read nothing.

## Getting a token

```bash
curl -s https://auth.xfeatures.net/oauth/token \
  -d grant_type=client_credentials \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET"
```

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600, "scope": "athenaeum" }
```

Then call Athenaeum with it:

```bash
curl -s https://athenaeum.xfeatures.net/v1/knowledge/search \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query": "escalation policy", "domain": "support"}'
```

## Caching the token

Tokens last an hour. Fetching one per request is slow and pointless; caching one
past its expiry is an outage. Refresh slightly early — HQ's own client
(`xfeatures-hq-api/src/utils/athenaeum.ts`) refreshes a minute before expiry and
holds nothing if the grant fails, which is a reasonable pattern to copy.

Cache per isolate, in memory. Do not write a token to KV, D1, or disk.

## Failure modes

| Response | What it usually means |
|---|---|
| `400 invalid_scope` | The application has no capabilities attached, so the grant produces no `athenaeum` scope |
| `401 invalid_client` | Wrong `client_id`/`client_secret`, or the application is not `app_type: "service"` |
| `401` from Athenaeum with a valid token | The token is fine; there is no active Athenaeum principal for that `client_id` |
| `404` on a read that should exist | The principal is authenticated but not cleared for that document's classification or domain |

That last row is deliberate — see the note on read denials in
[AUTHENTICATION.md](AUTHENTICATION.md#what-failures-look-like).

## Rotating the secret

Rotate at Account. The old secret stops working immediately; there is no
grace-period dual-secret support, so deploy the new one to the service first or
accept a gap. Revoking the Athenaeum principal instead (`status: "revoked"`) cuts
the service off within the introspection cache window without touching its Account
identity — that is the faster lever in an incident.
