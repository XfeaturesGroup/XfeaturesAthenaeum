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
  it("describes this resource and points at Account as the authorization server", async () => {
    const request = new Request("https://athenaeum.test/.well-known/oauth-protected-resource");
    const response = await handleProtectedResourceMetadata(
      request,
      ctxFor(request, { ACCOUNT_INTROSPECTION_URL: "https://auth.example.com/oauth/introspect" })
    );
    const body = await response.json<{ resource: string; authorization_servers: string[]; bearer_methods_supported: string[] }>();

    expect(body.resource).toBe("https://athenaeum.test");
    expect(body.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("reports no authorization server when the Account integration is unconfigured, rather than a stale/guessed URL", async () => {
    const request = new Request("https://athenaeum.test/.well-known/oauth-protected-resource");
    const response = await handleProtectedResourceMetadata(request, ctxFor(request, { ACCOUNT_INTROSPECTION_URL: undefined }));
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
