import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticateHttpRequest } from "../../src/auth/authenticate";
import { clearAccountTokenCache } from "../../src/auth/account-token";
import { AgentsRepository } from "../../src/repositories/agents.repository";
import { RolesRepository } from "../../src/repositories/roles.repository";
import type { Env } from "../../src/env";
import { seedSecurityFixtures } from "../helpers/fixtures";

/**
 * Regression suite for the Xfeatures Account identity path (ADR 0001).
 *
 * This is the newest and largest attack surface added in the integration
 * phase: Athenaeum now accepts bearer tokens minted by another system. The
 * properties proven here are that a valid Account token grants exactly the
 * Athenaeum permissions recorded for that specific Account identity and
 * nothing else -- and that every failure mode denies.
 */

const INTROSPECTION_URL = "https://auth.test/oauth/introspect";

// The Account integration is configured through env; the test env has no such
// vars, so a per-test override object is passed instead of mutating globals.
function accountEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    ACCOUNT_INTROSPECTION_URL: INTROSPECTION_URL,
    ACCOUNT_CLIENT_ID: "xf_athenaeum",
    ACCOUNT_CLIENT_SECRET: "athenaeum-introspection-secret",
    ...overrides
  };
}

/** Stubs the introspection endpoint. `body` is what Xfeatures Account would answer. */
function stubIntrospection(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== INTROSPECTION_URL) throw new Error(`unexpected fetch to ${url}`);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    })
  );
}

function bearer(token: string): Request {
  return new Request("https://athenaeum.test/v1/knowledge/search", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
}

const SUPPORT_BOT_CLIENT = "xf_supportbot";
const NETWORK_AGENT_CLIENT = "xf_networkagent";
const DISABLED_CLIENT = "xf_disabledbot";

beforeAll(async () => {
  const testEnv = env as unknown as Env;
  await seedSecurityFixtures(testEnv);

  const agents = new AgentsRepository(testEnv.DB);
  const roles = new RolesRepository(testEnv.DB);

  const supportRole = await roles.getByName("support-agent");
  const publicRole = await roles.getByName("public-agent");
  if (!supportRole || !publicRole) throw new Error("role fixtures missing");

  // Two applications with deliberately different scopes, mirroring the
  // acceptance test in the brief: SupportBot vs NetworkAgent.
  const supportBot = await agents.create({
    agentKey: "supportbot-app",
    name: "SupportBot",
    environment: (env as unknown as Env).ENVIRONMENT,
    authMode: "account",
    principalType: "APPLICATION",
    accountClientId: SUPPORT_BOT_CLIENT,
    createdBy: "test"
  });
  await agents.assignRole(supportBot.id, supportRole.id);

  const networkAgent = await agents.create({
    agentKey: "networkagent-app",
    name: "NetworkAgent",
    environment: (env as unknown as Env).ENVIRONMENT,
    authMode: "account",
    principalType: "AI_AGENT",
    accountClientId: NETWORK_AGENT_CLIENT,
    createdBy: "test"
  });
  await agents.assignRole(networkAgent.id, publicRole.id);

  const disabled = await agents.create({
    agentKey: "disabled-app",
    name: "DisabledBot",
    environment: (env as unknown as Env).ENVIRONMENT,
    authMode: "account",
    principalType: "APPLICATION",
    accountClientId: DISABLED_CLIENT,
    createdBy: "test"
  });
  await agents.assignRole(disabled.id, supportRole.id);
  await agents.setStatus(disabled.id, "disabled", "test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccountTokenCache();
});

describe("a valid Account application token resolves to that application's principal", () => {
  it("authenticates SupportBot and grants exactly its recorded permissions", async () => {
    stubIntrospection({ active: true, client_id: SUPPORT_BOT_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });

    const result = await authenticateHttpRequest(bearer("support-token"), accountEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.principal.agentKey).toBe("supportbot-app");
    // Support scope, per the seeded role.
    expect(result.principal.permissions.has("documents.read.support")).toBe(true);
    // And nothing beyond it.
    expect(result.principal.permissions.has("documents.read.network")).toBe(false);
    expect(result.principal.permissions.has("admin.agents")).toBe(false);
  });

  it("does not leak SupportBot's scope to NetworkAgent (application isolation)", async () => {
    stubIntrospection({ active: true, client_id: NETWORK_AGENT_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });

    const result = await authenticateHttpRequest(bearer("network-token"), accountEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.principal.agentKey).toBe("networkagent-app");
    // The public-agent role has no support-domain access, so compromising
    // SupportBot cannot yield NetworkAgent's scope or vice versa.
    expect(result.principal.permissions.has("documents.read.support")).toBe(false);
    expect(result.principal.permissions.has("documents.read.public")).toBe(true);
  });
});

describe("every Account token failure mode denies", () => {
  it("denies an inactive token", async () => {
    stubIntrospection({ active: false });
    const result = await authenticateHttpRequest(bearer("revoked-token"), accountEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_TOKEN");
  });

  it("denies a token whose application has no Athenaeum principal (no implicit registration)", async () => {
    stubIntrospection({ active: true, client_id: "xf_never_registered", scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });
    const result = await authenticateHttpRequest(bearer("stranger-token"), accountEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNKNOWN_AGENT");
  });

  it("denies a token that lacks the coarse athenaeum scope", async () => {
    // A valid ecosystem token for some other product must not reach Athenaeum.
    stubIntrospection({ active: true, client_id: SUPPORT_BOT_CLIENT, scope: "openid email", exp: Math.floor(Date.now() / 1000) + 3600 });
    const result = await authenticateHttpRequest(bearer("wrong-scope-token"), accountEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_TOKEN");
  });

  it("denies a disabled application even with a valid token", async () => {
    stubIntrospection({ active: true, client_id: DISABLED_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });
    const result = await authenticateHttpRequest(bearer("disabled-token"), accountEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AGENT_DISABLED");
  });

  it("denies when introspection is unreachable (fail closed, never fail open)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await Promise.resolve();
        throw new Error("network down");
      })
    );
    const result = await authenticateHttpRequest(bearer("any-token"), accountEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_TOKEN");
  });

  it("denies when introspection returns a server error", async () => {
    stubIntrospection({ error: "server_error" }, 500);
    const result = await authenticateHttpRequest(bearer("any-token"), accountEnv());
    expect(result.ok).toBe(false);
  });

  it("denies when the Account integration is not configured at all", async () => {
    stubIntrospection({ active: true, client_id: SUPPORT_BOT_CLIENT, scope: "athenaeum" });
    const result = await authenticateHttpRequest(
      bearer("token"),
      accountEnv({ ACCOUNT_CLIENT_SECRET: undefined, ACCOUNT_CLIENT_ID: undefined, ACCOUNT_INTROSPECTION_URL: undefined })
    );
    expect(result.ok).toBe(false);
  });

  it("denies an empty bearer value", async () => {
    const request = new Request("https://athenaeum.test/v1/knowledge/search", {
      method: "POST",
      headers: { authorization: "Bearer " }
    });
    const result = await authenticateHttpRequest(request, accountEnv());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_CREDENTIALS");
  });
});

describe("client-supplied identity is never authority", () => {
  it("ignores a forged client_id in the request body and uses only the introspected one", async () => {
    // The token genuinely belongs to the low-privilege NetworkAgent; the body
    // claims to be SupportBot. The introspected identity must win.
    stubIntrospection({ active: true, client_id: NETWORK_AGENT_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });

    const request = new Request("https://athenaeum.test/v1/knowledge/search", {
      method: "POST",
      headers: { authorization: "Bearer network-token", "content-type": "application/json" },
      body: JSON.stringify({
        query: "x",
        client_id: SUPPORT_BOT_CLIENT,
        account_id: "attacker",
        agent_id: "supportbot-app",
        permissions: ["admin.agents"],
        role: "knowledge-admin",
        classification: "RESTRICTED"
      })
    });

    const result = await authenticateHttpRequest(request, accountEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.agentKey).toBe("networkagent-app");
    expect(result.principal.permissions.has("admin.agents")).toBe(false);
    expect(result.principal.permissions.has("documents.read.support")).toBe(false);
  });

  it("ignores forged identity headers", async () => {
    stubIntrospection({ active: true, client_id: NETWORK_AGENT_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });

    const request = new Request("https://athenaeum.test/v1/knowledge/search", {
      method: "POST",
      headers: {
        authorization: "Bearer network-token",
        "x-account-id": "attacker",
        "x-application-id": SUPPORT_BOT_CLIENT,
        "x-agent-id": "supportbot-app",
        "x-permissions": "admin.agents"
      }
    });

    const result = await authenticateHttpRequest(request, accountEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.agentKey).toBe("networkagent-app");
    expect(result.principal.permissions.has("admin.agents")).toBe(false);
  });

  it("a scope string in the token cannot itself confer knowledge permissions", async () => {
    // Even if an attacker could influence the token's scope, Athenaeum reads
    // permissions from its own D1 -- the scope only opens the coarse gate.
    stubIntrospection({
      active: true,
      client_id: NETWORK_AGENT_CLIENT,
      scope: "athenaeum admin.agents documents.read.network knowledge.classification.RESTRICTED",
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(bearer("scope-stuffed-token"), accountEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.permissions.has("admin.agents")).toBe(false);
    expect(result.principal.permissions.has("documents.read.network")).toBe(false);
    expect(result.principal.permissions.has("knowledge.classification.RESTRICTED")).toBe(false);
  });
});

describe("token verification caching is bounded and identity-correct", () => {
  it("does not serve one application's cached identity to another application's token", async () => {
    stubIntrospection({ active: true, client_id: SUPPORT_BOT_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });
    const first = await authenticateHttpRequest(bearer("token-A"), accountEnv());
    expect(first.ok && first.principal.agentKey).toBe("supportbot-app");

    // A different token value must be introspected independently, not served
    // from the first token's cache entry.
    stubIntrospection({ active: true, client_id: NETWORK_AGENT_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });
    const second = await authenticateHttpRequest(bearer("token-B"), accountEnv());
    expect(second.ok && second.principal.agentKey).toBe("networkagent-app");
  });

  it("does not cache a denial (a transient outage must not pin a caller into failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await Promise.resolve();
        throw new Error("transient");
      })
    );
    const failed = await authenticateHttpRequest(bearer("token-C"), accountEnv());
    expect(failed.ok).toBe(false);

    vi.unstubAllGlobals();
    stubIntrospection({ active: true, client_id: SUPPORT_BOT_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) + 3600 });
    const recovered = await authenticateHttpRequest(bearer("token-C"), accountEnv());
    expect(recovered.ok).toBe(true);
  });

  it("never caches past the token's own expiry", async () => {
    // exp already in the past: the entry must not be reusable at all.
    stubIntrospection({ active: true, client_id: SUPPORT_BOT_CLIENT, scope: "athenaeum", exp: Math.floor(Date.now() / 1000) - 1 });
    await authenticateHttpRequest(bearer("expired-exp-token"), accountEnv());

    const fetchSpy = vi.fn(async () => {
      await Promise.resolve();
      return new Response(JSON.stringify({ active: false }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const second = await authenticateHttpRequest(bearer("expired-exp-token"), accountEnv());

    // Re-introspected rather than served from cache, and now denied.
    expect(fetchSpy).toHaveBeenCalled();
    expect(second.ok).toBe(false);
  });
});

const DEVELOPER_ACCESS_CLIENT = "xf_athenaeum_developer_access";
const DEVELOPER_USER_ID = "acct-user-dev-1";
const UNLINKED_USER_ID = "acct-user-unlinked-1";

/**
 * A human developer's own Account login (Authorization Code, not
 * client_credentials) can never carry the coarse `athenaeum` scope -- Account
 * only ever unions internal capabilities into a token for `app_type:
 * "service"` applications, which have no consent screen and no subject. This
 * is the second, narrower door: a user-delegated token from exactly one
 * pre-registered client_id, with Athenaeum's own D1 still deciding whether
 * that specific person has a principal at all (src/auth/account-token.ts).
 */
describe("a human developer's Account login (Developer Access client)", () => {
  beforeAll(async () => {
    const testEnv = env as unknown as Env;
    const agents = new AgentsRepository(testEnv.DB);
    const roles = new RolesRepository(testEnv.DB);
    const contributorRole = await roles.getByName("limited-fact-admin"); // any seeded role works; permissions aren't the point here
    if (!contributorRole) throw new Error("role fixture missing");

    const developer = await agents.create({
      agentKey: "developer-dev-1",
      name: "Developer (dev-1)",
      environment: testEnv.ENVIRONMENT,
      authMode: "account",
      principalType: "USER",
      accountUserId: DEVELOPER_USER_ID,
      createdBy: "test"
    });
    await agents.assignRole(developer.id, contributorRole.id);
  });

  it("accepts a user-delegated token from the trusted client with no athenaeum scope, resolved by subject", async () => {
    stubIntrospection({
      active: true,
      client_id: DEVELOPER_ACCESS_CLIENT,
      sub: DEVELOPER_USER_ID,
      scope: "openid profile:username email", // ordinary consent scopes only -- never "athenaeum"
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(
      bearer("developer-login-token"),
      accountEnv({ ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID: DEVELOPER_ACCESS_CLIENT })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.agentKey).toBe("developer-dev-1");
  });

  it("still denies a scope-less token from any OTHER client, trusted or not", async () => {
    stubIntrospection({
      active: true,
      client_id: "xf_some_other_user_app",
      sub: DEVELOPER_USER_ID,
      scope: "openid profile:username",
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(
      bearer("wrong-app-token"),
      accountEnv({ ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID: DEVELOPER_ACCESS_CLIENT })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_TOKEN");
  });

  it("denies a token from the trusted client that has no subject (never a machine token in disguise)", async () => {
    stubIntrospection({
      active: true,
      client_id: DEVELOPER_ACCESS_CLIENT,
      scope: "openid",
      // no `sub` at all
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(
      bearer("subjectless-token"),
      accountEnv({ ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID: DEVELOPER_ACCESS_CLIENT })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_TOKEN");
  });

  it("the alternate path is fully disabled when ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID is unset", async () => {
    stubIntrospection({
      active: true,
      client_id: DEVELOPER_ACCESS_CLIENT,
      sub: DEVELOPER_USER_ID,
      scope: "openid",
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(
      bearer("no-config-token"),
      accountEnv({ ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID: undefined })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_TOKEN");
  });

  it("a real person with no Athenaeum principal is refused, not silently registered", async () => {
    stubIntrospection({
      active: true,
      client_id: DEVELOPER_ACCESS_CLIENT,
      sub: UNLINKED_USER_ID,
      scope: "openid",
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(
      bearer("unlinked-person-token"),
      accountEnv({ ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID: DEVELOPER_ACCESS_CLIENT })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNKNOWN_AGENT");
  });
});

/**
 * The HQ Access page creates an Athenaeum agent linked to an Account identity
 * (POST /v1/admin/agents with auth_mode "account"). resolvePrincipalForAccountIdentity
 * resolves that link with a `SELECT ... LIMIT` equivalent (findByAccountClientId /
 * findByAccountUserId), which picks exactly one row. If a second agent were ever
 * linked to the same Account identity, whichever one the lookup does not return
 * would be permanently unreachable through the account auth path -- not merely
 * redundant, but silently dead. The creation handler pre-checks this and refuses
 * a second link; this pins the invariant it depends on.
 */
describe("at most one Athenaeum agent may be linked to a given Account identity", () => {
  it("the repository lookup used for the pre-check finds an existing link", async () => {
    const agentsRepo = new AgentsRepository((env as unknown as Env).DB);
    const clientId = "xf_duplicate-link-test-client";

    const existing = await agentsRepo.findByAccountClientId(clientId);
    expect(existing).toBeNull();

    await agentsRepo.create({
      agentKey: "duplicate-link-test-agent",
      name: "Duplicate link test",
      environment: (env as unknown as Env).ENVIRONMENT,
      authMode: "account",
      principalType: "APPLICATION",
      accountClientId: clientId,
      createdBy: "test-fixture"
    });

    const found = await agentsRepo.findByAccountClientId(clientId);
    expect(found?.account_client_id).toBe(clientId);
  });
});

/**
 * SR-024 regression.
 *
 * The Developer Access application is a PUBLIC client: anyone with an
 * Xfeatures Account can complete its PKCE flow, and its user-delegated tokens
 * are admitted without the coarse `athenaeum` scope. That is safe only for as
 * long as such a token resolves to the SPECIFIC person behind it.
 *
 * Before the fix, `resolvePrincipalForAccountIdentity` fell through to
 * `findByAccountClientId` whenever the subject was unknown -- so a single
 * agent row linked to the Developer Access client id would have handed its
 * permissions to every Account holder on earth. Nothing prevented that row
 * from existing: `POST /v1/admin/agents` accepted it and HQ's Access page
 * exposes the field.
 *
 * The row below is exactly that misconfiguration, seeded deliberately. The
 * property under test is that it changes nothing.
 */
const DEV_ACCESS_CONFLICT_AGENT_KEY = "devaccess-conflict-app";
const STRANGER_USER_ID = "acct-user-stranger-1";

describe("SR-024: an agent row linked to the Developer Access client id confers nothing", () => {
  beforeAll(async () => {
    const testEnv = env as unknown as Env;
    const agents = new AgentsRepository(testEnv.DB);
    const roles = new RolesRepository(testEnv.DB);

    // The most powerful role in the system, to make the escalation obvious if
    // it ever comes back.
    const adminRole = await roles.getByName("knowledge-admin");
    if (!adminRole) throw new Error("role fixture missing");

    const conflicting = await agents.create({
      agentKey: DEV_ACCESS_CONFLICT_AGENT_KEY,
      name: "Misconfigured Developer Access link",
      environment: testEnv.ENVIRONMENT,
      authMode: "account",
      principalType: "APPLICATION",
      accountClientId: DEVELOPER_ACCESS_CLIENT,
      createdBy: "test"
    });
    await agents.assignRole(conflicting.id, adminRole.id);
  });

  it("a stranger's Developer Access token does not inherit the application row's principal", async () => {
    stubIntrospection({
      active: true,
      client_id: DEVELOPER_ACCESS_CLIENT,
      sub: STRANGER_USER_ID, // a real Account holder, unknown to Athenaeum
      scope: "openid profile:username email",
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(
      bearer("stranger-developer-access-token"),
      accountEnv({ ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID: DEVELOPER_ACCESS_CLIENT })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNKNOWN_AGENT");
  });

  it("the person who IS linked still resolves to their own principal, not the application row", async () => {
    stubIntrospection({
      active: true,
      client_id: DEVELOPER_ACCESS_CLIENT,
      sub: DEVELOPER_USER_ID,
      scope: "openid",
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(
      bearer("linked-developer-access-token"),
      accountEnv({ ACCOUNT_DEVELOPER_ACCESS_CLIENT_ID: DEVELOPER_ACCESS_CLIENT })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.agentKey).toBe("developer-dev-1");
    expect(result.principal.agentKey).not.toBe(DEV_ACCESS_CONFLICT_AGENT_KEY);
  });

  /**
   * A machine token from an ordinary service application is a different case
   * and must keep working: there is no subject to resolve, so the client_id
   * link is the only thing there is. Pinned here so the SR-024 fix cannot
   * quietly disable the service path with it.
   */
  it("an ordinary service application still resolves by client_id", async () => {
    stubIntrospection({
      active: true,
      client_id: SUPPORT_BOT_CLIENT,
      scope: "athenaeum",
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await authenticateHttpRequest(bearer("supportbot-machine-token"), accountEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.agentKey).toBe("supportbot-app");
  });
});
