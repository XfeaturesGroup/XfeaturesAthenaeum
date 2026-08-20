# REST quick start

Five minutes from nothing to a search result. This assumes you already have
credentials — if not, start with
[OAUTH-CLIENT-CREDENTIALS.md](OAUTH-CLIENT-CREDENTIALS.md) for a service or
[OAUTH-PKCE.md](OAUTH-PKCE.md) for yourself.

## 1. Get a token

```bash
TOKEN=$(curl -s https://auth.xfeatures.net/oauth/token \
  -d grant_type=client_credentials \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" | jq -r .access_token)
```

## 2. Search

```bash
curl -s https://athenaeum.xfeatures.net/v1/knowledge/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query": "what is the refund window", "domain": "support", "limit": 5}'
```

Results come back as passages with citations. If nothing matches well enough you
get an explicit answer rather than a confident wrong one:

```json
{ "results": [], "reason": "NO_RELIABLE_MATCH" }
```

Athenaeum never calls an LLM. It returns evidence; deciding what to do with it is
the caller's job — including treating it as untrusted content. See
[AGENT-INTEGRATION.md](AGENT-INTEGRATION.md).

## 3. Read a specific thing

```bash
curl -s "https://athenaeum.xfeatures.net/v1/facts/billing/refund_window_days" \
  -H "Authorization: Bearer $TOKEN"

curl -s "https://athenaeum.xfeatures.net/v1/documents/$DOCUMENT_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## The surface

| Path | What it is |
|---|---|
| `POST /v1/knowledge/search` | Semantic search, ACL-filtered before and after retrieval |
| `GET /v1/facts/{namespace}/{key}` | One structured fact |
| `GET /v1/facts/{namespace}` | Facts in a namespace |
| `GET /v1/documents/{id}` | One document |
| `GET /v1/products/{code}`, `/v1/plans/{code}`, `/v1/policies/{code}` | Catalog reads |
| `POST /v1/feedback` | Report that an answer was wrong or stale |
| `GET /health` | Liveness, unauthenticated |
| `/v1/admin/*` | Everything privileged: documents, facts, agents, roles, trash, audit |

The full surface with request and response schemas is in
[`openapi.yaml`](openapi.yaml), which CI checks against the actual route table — so
it cannot quietly drift from the code.

## Publishing needs a person

An agent can draft a document and submit it for review. No transport exposes a way
to publish one:

```bash
# Draft it…
curl -s -X POST https://athenaeum.xfeatures.net/v1/admin/documents \
  -H "Authorization: Bearer $TOKEN" -F file=@handbook.md -F domain=support

# …then ask a human to look.
curl -s -X POST "https://athenaeum.xfeatures.net/v1/admin/documents/$ID/submit-for-review" \
  -H "Authorization: Bearer $TOKEN"
```

## Errors

Standard status codes with a machine-readable `code`. Two worth knowing about:

- A read you are not cleared for returns `404`, not `403` — a `403` would confirm
  the thing exists.
- Rate limits are per identity, not per IP, because internal agents share egress.

## Client libraries

If you are writing TypeScript, skip the curl:
[`@xfeaturesgroup/athenaeum`](https://www.npmjs.com/package/@xfeaturesgroup/athenaeum).
