import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleProtectedResourceMetadata } from "../../src/api/routes/well-known";
import { handleMcpRequest } from "../../src/mcp/server";
import type { Env } from "../../src/env";
import type { RouteContext } from "../../src/api/router";

const testEnv = env as unknown as Env;

function ctxFor(request: Request, envOverrides: Partial<Env> = {}): RouteContext {
  return {
    env: { ...testEnv, ...envOverrides },
    params: {},
    requestId: "test-request-id",
    url: new URL(request.url),
    clientKey: "127.0.0.1"
  };
}

describe("RFC 9728 protected-resource metadata", () => {
  it("describes this resource and points at the configured authorization-server issuer", async () => {
    const request = new Request("https://athenaeum.test/.well-known/oauth-protected-resource");
    const response = await handleProtectedResourceMetadata(
      request,
      ctxFor(request, { ACCOUNT_ISSUER: "https://issuer.example.com" })
    );
    const body = await response.json<{
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
      scopes_supported: string[];
    }>();

    expect(body.resource).toBe("https://athenaeum.test");
    expect(body.authorization_servers).toEqual(["https://issuer.example.com"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    // What a generic MCP client should ask the authorization server for. The
    // Developer Access application grants exactly these; requesting more would
    // be silently dropped at consent and confuse the operator.
    expect(body.scopes_supported).toEqual(["openid", "profile:username", "email"]);
  });

  /**
   * The issuer is NOT derived from the introspection endpoint.
   *
   * Introspection is an internal, client-authenticated call between two
   * Workers; the issuer is a public identity a third-party client validates
   * against the metadata it fetches (RFC 8414 §3.3). They are allowed to live
   * on different hostnames, and here they do: introspection travels to
   * `auth.xfeatures.net`, while the advertised issuer is the canonical OAuth
   * identity `api.account.xfeatures.net`. Inferring one from the other sent
   * MCP clients to an origin whose metadata document does not exist.
   */
  it("does not infer the issuer from the introspection URL", async () => {
    const request = new Request("https://athenaeum.test/.well-known/oauth-protected-resource");
    const response = await handleProtectedResourceMetadata(
      request,
      ctxFor(request, {
        ACCOUNT_ISSUER: "https://issuer.example.com",
        ACCOUNT_INTROSPECTION_URL: "https://internal-introspection.example.net/oauth/introspect"
      })
    );
    const body = await response.json<{ authorization_servers: string[] }>();

    expect(body.authorization_servers).toEqual(["https://issuer.example.com"]);
  });

  it("reports no authorization server when the issuer is unconfigured, rather than a stale/guessed URL", async () => {
    const request = new Request("https://athenaeum.test/.well-known/oauth-protected-resource");
    const response = await handleProtectedResourceMetadata(
      request,
      ctxFor(request, { ACCOUNT_ISSUER: undefined, ACCOUNT_INTROSPECTION_URL: "https://auth.example.com/oauth/introspect" })
    );
    const body = await response.json<{ authorization_servers: string[] }>();

    expect(body.authorization_servers).toEqual([]);
  });
});

describe("MCP's 401 points a remote client at the discovery document", () => {
  it("carries a WWW-Authenticate header with resource_metadata on an unauthenticated request", async () => {
    const request = new Request("https://athenaeum.test/mcp", { method: "POST" });
    const response = await handleMcpRequest(request, testEnv);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://athenaeum.test/.well-known/oauth-protected-resource"'
    );
  });
});
