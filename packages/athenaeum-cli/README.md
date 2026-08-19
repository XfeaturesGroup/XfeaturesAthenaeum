# @xfeatures/athenaeum-cli

Personal command-line access to Xfeatures Athenaeum: sign in with your own Xfeatures Account, then search, read and propose documents from the terminal — no service credential, no HQ-issued RPC key.

```bash
npm run build
node dist/cli.js login
node dist/cli.js search "refund window for annual plans"
```

## How sign-in works

`athenaeum login` runs a standard Authorization Code + PKCE flow against Xfeatures Account:

1. Opens your browser to Account's consent screen for the **Athenaeum Developer Access** application.
2. You sign in to Account (if you aren't already) and approve.
3. Account redirects your browser to a one-shot local server (`http://localhost:8765/callback` by default) with an authorization code.
4. The CLI exchanges that code — together with the PKCE `code_verifier` it generated and kept only in memory — for an access token, and stores it at `~/.athenaeum/credentials.json` (mode `0600`).

Whether your Account identity can actually reach Athenaeum, and with which role, is decided entirely by Athenaeum's own database — specifically, whether an HQ operator has linked your Account user to an Athenaeum principal from the **Access** page (`Grant access` → `Account user`). Signing in with Account and being *authorized inside Athenaeum* are two different steps; this CLI only does the first one for you.

## Configuration

`login` needs to know which Account application to authenticate against:

| Variable | Required | Default |
|---|---|---|
| `ATHENAEUM_CLIENT_ID` | yes | — |
| `ATHENAEUM_ACCOUNT_WEB_URL` | no | `https://account.xfeatures.net` |
| `ATHENAEUM_ACCOUNT_API_URL` | no | `https://api.account.xfeatures.net` |
| `ATHENAEUM_BASE_URL` | no | `https://xfeatures-athenaeum.xfeatures.workers.dev` |
| `ATHENAEUM_REDIRECT_URI` | no | `http://localhost:8765/callback` |

`ATHENAEUM_CLIENT_ID` identifies the *application*, not you — get it from whoever administers the Athenaeum Developer Access application in your environment. A `client_id` is public by design in OAuth 2.0: it names the client, it does not authenticate it. Every other command (`search`, `whoami`, ...) only needs the token already saved by `login`, so it is only required once, at sign-in.

### There is no client_secret, on purpose

This CLI is registered with Xfeatures Account as a **public client** (`token_endpoint_auth_method: "none"` — RFC 6749 §2.1, RFC 7591 §2, RFC 8252). It holds no `client_secret` and never sends one, because a secret shipped to every machine that installs a CLI is not a secret. RFC 8252 §8.5 is explicit on this point, and a "secret" that is really public is worse than none at all: it invites people to believe it protects them.

**PKCE is the whole of client authentication here.** A fresh `code_verifier` is generated per login, stays in this process's memory, and is transmitted exactly once — at the final token exchange. Without it the authorization code is useless, even to something that captured every other request and response.

Account gained this client type specifically so this CLI would not have to pretend: before it, `oauth_applications.client_secret_hash` was `NOT NULL` and registration always minted a secret, which made the token endpoint's own public-client branch unreachable dead code. See `migrations/0028_public_native_oauth_clients.sql` in `xfeatures-auth-api`.

## Commands

```
athenaeum login
athenaeum logout
athenaeum whoami
athenaeum search <query> [--domain D] [--limit N]
athenaeum get-fact <namespace> <key>
athenaeum get-document <id-or-slug> [--content]
athenaeum get-product <code>
athenaeum get-plan <code>
athenaeum get-policy <code>
athenaeum propose-document <slug> --title T --domain D --classification C --language L --file PATH [--category C] [--format markdown|text|json|html]
athenaeum submit-for-review <document-id>
```

`propose-document` and `submit-for-review` are human-in-the-loop: they can create and submit a draft, never publish one. Publishing is HQ-only, by a person holding `documents.publish`.

## Known limitations (v1)

- **No automatic token refresh.** When your token expires, run `login` again. (Now that this is a public client the old objection — needing a secret on every command — no longer applies; refresh is simply not implemented yet. Account already issues and rotates refresh tokens for the authorization-code grant, so this is a CLI-side gap, not a protocol one.)
- **The loopback port is fixed** at `8765` (override with `ATHENAEUM_REDIRECT_URI`). RFC 8252 §7.3 says an authorization server *should* accept any port on a loopback redirect; Account matches redirect URIs exactly, so if that port is busy, `login` fails rather than picking another. Registering both `localhost` and `127.0.0.1` variants covers the common cases.
- **No `whoami` identity endpoint.** Athenaeum has none yet, so `whoami` reports token expiry and does a cheap real call to confirm the token is currently accepted, rather than showing your name or role.
