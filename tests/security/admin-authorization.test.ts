import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRouter } from "../../src/api/routes/index";
import type { Env } from "../../src/env";
import { createAgent, createFact, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;
const router = buildRouter();

let publicAgent: SeededAgent;
let supportAgent: SeededAgent;

/**
 * These tests drive the REAL router, so they exercise the actual production
 * request path: route match -> pipeline -> authenticate -> authorize ->
 * handler. They are the regression for SR-001, the critical finding in which
 * every administrative route was reachable by any authenticated principal
 * because `runAuthenticatedOperation` only labelled the audit entry and never
 * called authorize().
 *
 * Authentication here is deliberately *unsatisfiable* (no Access JWT is
 * mintable in tests), so every request lands on UNAUTHENTICATED. That is
 * still the security property that matters most for these routes: an
 * anonymous caller must never reach the handler. The classification and
 * privilege-containment properties that need a real Principal are proven in
 * authorization-matrix.test.ts against the service layer directly.
 */
beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  publicAgent = await createAgent(testEnv, "public-bot", "public-agent");
  supportAgent = await createAgent(testEnv, "support-bot", "support-agent");
  await createFact(testEnv, "secrets", "master-key", "RESTRICTED", { value: "top-secret" });
  await createFact(testEnv, "products", "widget", "PUBLIC", { value: "public info" });
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return router.handle(new Request(`https://kc.test${path}`, init), testEnv);
}

const ADMIN_ROUTES: { method: string; path: string; body?: unknown }[] = [
  { method: "POST", path: "/v1/admin/agents", body: { agent_key: "evil", name: "Evil", environment: "development", auth_mode: "rpc", roles: ["knowledge-admin"] } },
  { method: "GET", path: "/v1/admin/agents" },
  { method: "GET", path: "/v1/admin/agents/some-id" },
  { method: "PATCH", path: "/v1/admin/agents/some-id/status", body: { status: "revoked" } },
  { method: "PATCH", path: "/v1/admin/agents/some-id/quota", body: { max_searches_per_day: 100 } },
  { method: "POST", path: "/v1/admin/agents/some-id/roles", body: { role: "support-agent" } },
  { method: "DELETE", path: "/v1/admin/agents/some-id/roles/support-agent" },
  { method: "GET", path: "/v1/admin/roles" },
  { method: "POST", path: "/v1/admin/facts", body: { namespace: "secrets", key: "planted", value: {}, classification: "PUBLIC" } },
  { method: "PATCH", path: "/v1/admin/facts/secrets/master-key", body: { classification: "PUBLIC" } },
  { method: "DELETE", path: "/v1/admin/facts/secrets/master-key" },
  { method: "POST", path: "/v1/admin/facts/secrets/master-key/rollback", body: { version: 1 } },
  { method: "GET", path: "/v1/admin/documents" },
  { method: "GET", path: "/v1/admin/documents/doc-id" },
  { method: "PATCH", path: "/v1/admin/documents/doc-id/status", body: { status: "active" } },
  { method: "POST", path: "/v1/admin/documents/doc-id/submit-for-review" },
  { method: "POST", path: "/v1/admin/documents/doc-id/review-decision", body: { approved: true } },
  { method: "POST", path: "/v1/admin/documents/doc-id/rollback", body: { version: 1 } },
  { method: "GET", path: "/v1/admin/ingestion" },
  { method: "POST", path: "/v1/admin/ingestion/doc-id/reindex" },
  { method: "POST", path: "/v1/admin/ingestion/reindex-all" },
  { method: "GET", path: "/v1/admin/audit" },
  { method: "GET", path: "/v1/admin/health/dependencies" }
];

describe("SR-001: no administrative route is reachable without credentials", () => {
  for (const route of ADMIN_ROUTES) {
    it(`${route.method} ${route.path} rejects an unauthenticated caller`, async () => {
      const response = await call(route.method, route.path, route.body);
      expect(response.status).toBe(401);
      const payload = await response.json<{ error: { code: string } }>();
      expect(payload.error.code).toBe("UNAUTHENTICATED");
    });
  }

  it("covers every /v1/admin route registered on the router", () => {
    // Guard against a new admin route being added without a matching case
    // here. If this fails, add the route above rather than lowering the bar.
    const registered = router.registeredRoutes().filter((r) => r.path.startsWith("/v1/admin"));
    const covered = new Set(ADMIN_ROUTES.map((r) => `${r.method} ${r.path.split("/").slice(0, 4).join("/")}`));
    const uncovered = registered.filter((r) => {
      const prefix = `${r.method} ${r.path.split("/").slice(0, 4).join("/")}`;
      return !covered.has(prefix);
    });
    expect(uncovered.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});

describe("SR-001: read routes also require authentication", () => {
  const READ_ROUTES: { method: string; path: string; body?: unknown }[] = [
    { method: "POST", path: "/v1/knowledge/search", body: { query: "anything" } },
    { method: "GET", path: "/v1/facts/secrets" },
    { method: "GET", path: "/v1/facts/secrets/master-key" },
    { method: "GET", path: "/v1/documents/some-doc" },
    { method: "GET", path: "/v1/products/widget" },
    { method: "GET", path: "/v1/plans/widget" },
    { method: "GET", path: "/v1/policies/some-policy" },
    { method: "POST", path: "/v1/feedback", body: { source_id: "x", type: "outdated" } }
  ];

  for (const route of READ_ROUTES) {
    it(`${route.method} ${route.path} rejects an unauthenticated caller`, async () => {
      const response = await call(route.method, route.path, route.body);
      expect(response.status).toBe(401);
    });
  }
});

describe("router surface has no unintended openings", () => {
  it("only /health is reachable without credentials", async () => {
    const response = await call("GET", "/health");
    expect(response.status).toBe(200);
    const payload = await response.json<{ status: string }>();
    expect(payload.status).toBe("ok");
  });

  it("/health does not disclose dependency or infrastructure detail", async () => {
    const response = await call("GET", "/health");
    const body = await response.json<Record<string, unknown>>();

    // Exactly two fields, and nothing describing the infrastructure behind it.
    expect(Object.keys(body).sort()).toEqual(["request_id", "status"]);
    expect(body["status"]).toBe("ok");

    // Scan only the field NAMES and the status value; request_id is a random
    // UUID whose hex digits would otherwise trip a naive substring scan.
    const scannable = [...Object.keys(body), String(body["status"])].join(" ").toLowerCase();
    for (const leak of ["d1", "r2", "database", "bucket", "queue", "ai_search", "binding", "version"]) {
      expect(scannable).not.toContain(leak);
    }
  });

  it("an unknown path is 404, not a fallthrough to a handler", async () => {
    const response = await call("GET", "/v1/admin/does-not-exist");
    expect(response.status).toBe(404);
  });

  it("an undocumented method on a real route is 405, never silently accepted", async () => {
    const response = await call("DELETE", "/v1/knowledge/search");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toContain("POST");
  });

  it("agents seeded for these tests are distinct identities", () => {
    expect(publicAgent.agentId).not.toBe(supportAgent.agentId);
  });
});
