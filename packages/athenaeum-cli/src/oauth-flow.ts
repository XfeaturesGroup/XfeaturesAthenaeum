import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { platform } from "node:os";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";
import type { CliConfig } from "./config.js";

export interface AuthorizationResult {
  code: string;
  state: string;
}

/**
 * Starts a one-shot local HTTP server on the redirect_uri's port, waits for
 * exactly one callback request, then closes. Public/native-client PKCE flows
 * (the same pattern `gh auth login` and `wrangler login` use) route the
 * browser back to localhost rather than to any hosted page this CLI does not
 * control.
 */
function waitForCallback(redirectUri: string): { server: Server; result: Promise<AuthorizationResult> } {
  const target = new URL(redirectUri);
  let resolveResult!: (value: AuthorizationResult) => void;
  let rejectResult!: (reason: Error) => void;
  const result = new Promise<AuthorizationResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (requestUrl.pathname !== target.pathname) {
      res.writeHead(404).end();
      return;
    }

    const error = requestUrl.searchParams.get("error");
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      error
        ? `<!doctype html><html><body style="font-family:sans-serif"><p>Sign-in failed: ${escapeHtml(error)}. You can close this tab and check the terminal.</p></body></html>`
        : `<!doctype html><html><body style="font-family:sans-serif"><p>Signed in to Xfeatures Athenaeum. You can close this tab.</p></body></html>`
    );

    setImmediate(() => server.close());
    if (error) {
      rejectResult(new Error(`Xfeatures Account reported: ${error}`));
    } else if (!code || !state) {
      rejectResult(new Error("Callback was missing code or state."));
    } else {
      resolveResult({ code, state });
    }
  });

  server.listen(Number(target.port));
  return { server, result };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Best-effort browser launch. Login still works if this fails -- the URL is always printed too. */
function openBrowser(url: string): void {
  const os = platform();
  try {
    if (os === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else if (os === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Fine -- the caller already printed the URL.
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

/**
 * Full Authorization Code + PKCE round trip against Xfeatures Account: opens
 * the Account web app's consent page (a frontend route -- see App.tsx's
 * `/oauth/authorize`, which itself calls Account's `/api/oauth-provider/authorize`),
 * waits for the localhost redirect, then exchanges the code for a token.
 *
 * No client_secret is sent, because this application does not have one: it is
 * registered with Account as a public client (`token_endpoint_auth_method:
 * "none"`). PKCE is the whole of client authentication here -- without the
 * matching code_verifier, generated fresh and kept only in this process's
 * memory until this exact step, the authorization code is useless even to
 * something that captured every other request and response.
 */
export async function loginWithAccount(config: CliConfig): Promise<TokenResponse> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authorizeUrl = new URL("/oauth/authorize", config.accountWebUrl);
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", config.scope);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const { result } = waitForCallback(config.redirectUri);

  console.log("Opening your browser to sign in with Xfeatures Account...");
  console.log(`If it doesn't open automatically, visit:\n  ${authorizeUrl.toString()}\n`);
  openBrowser(authorizeUrl.toString());

  const callback = await result;
  if (callback.state !== state) {
    throw new Error("State mismatch on the OAuth callback -- discarding this login attempt.");
  }

  const tokenUrl = new URL("/oauth/token", config.accountApiUrl);
  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier
    })
  });

  const body = (await tokenResponse.json()) as TokenResponse | { error: string; error_description?: string };
  if (!tokenResponse.ok || !("access_token" in body)) {
    const description = "error_description" in body ? body.error_description : undefined;
    const errorCode = "error" in body ? body.error : "unknown_error";
    throw new Error(`Token exchange failed: ${errorCode}${description ? ` -- ${description}` : ""}`);
  }
  return body;
}
