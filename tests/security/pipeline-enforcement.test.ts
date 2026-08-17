import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { runAuthenticatedOperation, type OperationAuthorization } from "../../src/auth/pipeline";
import type { AuthResult, Principal } from "../../src/auth/types";
import { ApiError, ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import { createAgent, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";
// Source is inlined at build time: tests run inside workerd, which has no filesystem.
import RPC_SOURCE from "../../src/rpc/entrypoint.ts?raw";
import REST_FACTS_SOURCE from "../../src/api/routes/facts.ts?raw";
import REST_DOCUMENTS_SOURCE from "../../src/api/routes/documents.ts?raw";
import REST_POLICIES_SOURCE from "../../src/api/routes/policies.ts?raw";
import CATALOG_SOURCE from "../../src/knowledge/catalog.ts?raw";
import FACTS_SERVICE_SOURCE from "../../src/knowledge/facts.ts?raw";
import DOCUMENTS_SERVICE_SOURCE from "../../src/knowledge/documents.ts?raw";
import POLICIES_SERVICE_SOURCE from "../../src/knowledge/policies.ts?raw";
import ADMIN_DOCUMENTS_SOURCE from "../../src/api/routes/admin/documents.ts?raw";

const testEnv = env as unknown as Env;

let publicAgent: SeededAgent;
let adminAgent: SeededAgent;

beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  publicAgent = await createAgent(testEnv, "pipe-public", "public-agent");
  adminAgent = await createAgent(testEnv, "pipe-admin", "knowledge-admin");
});

/** Injects an already-authenticated principal, isolating AUTHORIZATION from authentication. */
function authenticateAs(principal: Principal): () => Promise<AuthResult> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async () => ({ ok: true, principal });
}

interface RunOptions {
  principal: Principal;
  authorization: OperationAuthorization;
}

async function runOperation(options: RunOptions): Promise<{ handlerRan: boolean; error: ApiError | null }> {
  let handlerRan = false;
  try {
    await runAuthenticatedOperation({
      env: testEnv,
      requestId: `test-${crypto.randomUUID()}`,
      authorization: options.authorization,
      authenticate: authenticateAs(options.principal),
      // eslint-disable-next-line @typescript-eslint/require-await
      handler: async () => {
        handlerRan = true;
        return "SENSITIVE RESULT";
      }
    });
    return { handlerRan, error: null };
  } catch (error) {
    return { handlerRan, error: error instanceof ApiError ? error : null };
  }
}

/**
 * SR-001 REGRESSION -- the critical finding.
 *
 * The original `runAuthenticatedOperation` accepted a free-text `action:
 * string` used only as an audit label, and never called authorize(). Every
 * administrative route therefore ran its handler for ANY authenticated
 * principal. Testing this through HTTP is not sufficient: an unauthenticated
 * request is stopped by AUTHENTICATION, so such a test passes even with
 * authorization entirely disabled. These tests inject a valid weak principal
 * so that only the authorization step can possibly stop them.
 */
describe("SR-001: the pipeline enforces authorization, not just authentication", () => {
  const ADMIN_ACTIONS = [
    "admin.agents",
    "admin.facts",
    "admin.documents",
    "admin.ingestion",
    "audit.read",
    "documents.publish",
    "documents.write",
    "facts.write"
  ] as const;

  for (const action of ADMIN_ACTIONS) {
    it(`denies a public agent the "${action}" operation AND never runs its handler`, async () => {
      const { handlerRan, error } = await runOperation({
        principal: publicAgent.principal,
        authorization: { enforce: { action } }
      });

      expect(error).toBeInstanceOf(ApiError);
      expect(error?.code).toBe(ErrorCode.FORBIDDEN);
      // The handler is where repositories, queues and workflows are touched.
      // It must not execute at all -- denial after a side effect is not a denial.
      expect(handlerRan).toBe(false);
    });
  }

  for (const action of ADMIN_ACTIONS) {
    it(`allows a full knowledge admin the "${action}" operation`, async () => {
      const { handlerRan, error } = await runOperation({
        principal: adminAgent.principal,
        authorization: { enforce: { action } }
      });
      expect(error).toBeNull();
      expect(handlerRan).toBe(true);
    });
  }

  it("denies a resource-scoped operation the principal lacks the classification for", async () => {
    const { handlerRan, error } = await runOperation({
      principal: publicAgent.principal,
      authorization: { enforce: { action: "documents.read", resource: { domain: "network", classification: "RESTRICTED" } } }
    });
    expect(error?.code).toBe(ErrorCode.FORBIDDEN);
    expect(handlerRan).toBe(false);
  });

  it("allows a resource-scoped operation the principal does hold", async () => {
    const { handlerRan, error } = await runOperation({
      principal: publicAgent.principal,
      authorization: { enforce: { action: "documents.read", resource: { domain: "public", classification: "PUBLIC" } } }
    });
    expect(error).toBeNull();
    expect(handlerRan).toBe(true);
  });

  it("a deferred operation still reaches its handler (the handler owns the check)", async () => {
    const { handlerRan, error } = await runOperation({
      principal: publicAgent.principal,
      authorization: { deferred: { auditAction: "documents.read", enforcedBy: "test" } }
    });
    expect(error).toBeNull();
    expect(handlerRan).toBe(true);
  });

  it("an unauthenticated caller is refused before authorization is even considered", async () => {
    let handlerRan = false;
    await expect(
      runAuthenticatedOperation({
        env: testEnv,
        requestId: "test-unauth",
        authorization: { enforce: { action: "admin.agents" } },
        // eslint-disable-next-line @typescript-eslint/require-await
        authenticate: async () => ({ ok: false, reason: "UNKNOWN_AGENT" }),
        // eslint-disable-next-line @typescript-eslint/require-await
        handler: async () => {
          handlerRan = true;
          return null;
        }
      })
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
    expect(handlerRan).toBe(false);
  });

  it("a disabled agent is refused even though its credential once worked", async () => {
    let handlerRan = false;
    await expect(
      runAuthenticatedOperation({
        env: testEnv,
        requestId: "test-disabled",
        authorization: { enforce: { action: "knowledge.search" } },
        // eslint-disable-next-line @typescript-eslint/require-await
        authenticate: async () => ({ ok: false, reason: "AGENT_DISABLED" }),
        // eslint-disable-next-line @typescript-eslint/require-await
        handler: async () => {
          handlerRan = true;
          return null;
        }
      })
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
    expect(handlerRan).toBe(false);
  });

  it("an authorization backend failure denies rather than allows (fail closed)", async () => {
    let handlerRan = false;
    await expect(
      runAuthenticatedOperation({
        env: testEnv,
        requestId: "test-dep",
        authorization: { enforce: { action: "knowledge.search" } },
        // eslint-disable-next-line @typescript-eslint/require-await
        authenticate: async () => ({ ok: false, reason: "DEPENDENCY_UNAVAILABLE" }),
        // eslint-disable-next-line @typescript-eslint/require-await
        handler: async () => {
          handlerRan = true;
          return null;
        }
      })
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
    expect(handlerRan).toBe(false);
  });
});

/**
 * SR-002/SR-003 end-to-end through the pipeline: an admin.facts holder that
 * lacks RESTRICTED must be stopped, and must be stopped BEFORE the handler
 * performs any write.
 */
describe("SR-002/SR-003: administrative reach is bounded by classification", () => {
  it("a limited fact admin passes the admin.facts gate but is stopped at the resource guard", async () => {
    const limited = await createAgent(testEnv, "pipe-limited", "limited-fact-admin");

    // The coarse gate alone would let this through...
    const coarse = await runOperation({
      principal: limited.principal,
      authorization: { enforce: { action: "admin.facts" } }
    });
    expect(coarse.error).toBeNull();

    // ...but the resource-level check refuses the RESTRICTED fact itself.
    const scoped = await runOperation({
      principal: limited.principal,
      authorization: { enforce: { action: "facts.read", resource: { namespace: "secrets", classification: "RESTRICTED" } } }
    });
    expect(scoped.error?.code).toBe(ErrorCode.FORBIDDEN);
    expect(scoped.handlerRan).toBe(false);
  });
});

/**
 * `deferred` is the one way past the pipeline's own authorize() call, and it
 * is honoured entirely on trust: the pipeline runs the handler and relies on
 * the function named in `enforcedBy` to check for itself. That trust is only
 * sound while every named enforcer actually does it.
 *
 * `enforce` sites are structurally safe -- the pipeline checks them -- so
 * they need no tripwire. These do. If a new deferred site appears whose
 * enforcer never calls assertAuthorized, this fails rather than shipping a
 * route that reads as authorized and is not (which is exactly how SR-001
 * happened).
 */
describe("every deferred authorization site has an enforcer that really enforces", () => {
  const SERVICE_SOURCES: Record<string, string> = {
    "CatalogService": CATALOG_SOURCE,
    "FactsService": FACTS_SERVICE_SOURCE,
    "DocumentsService": DOCUMENTS_SERVICE_SOURCE,
    "PoliciesService": POLICIES_SERVICE_SOURCE
  };

  /** Every `enforcedBy: "X.y"` string across every transport that can defer. */
  const deferredSites = [...new Set(
    [RPC_SOURCE, REST_FACTS_SOURCE, REST_DOCUMENTS_SOURCE, REST_POLICIES_SOURCE]
      .flatMap((source) => [
        ...[...source.matchAll(/enforcedBy:\s*"([^"]+)"/g)].map((m) => m[1] ?? ""),
        ...[...source.matchAll(/deferredTo\(\s*"([^"]+)"/g)].map((m) => m[1] ?? "")
      ])
      .filter((name) => name.length > 0 && name !== "test")
  )];

  it("finds the deferred sites at all (guards against the regex silently matching nothing)", () => {
    expect(deferredSites.length).toBeGreaterThanOrEqual(8);
  });

  for (const site of deferredSites) {
    it(`${site} calls assertAuthorized itself`, () => {
      const serviceName = site.split(".")[0] ?? "";
      const source = SERVICE_SOURCES[serviceName];
      expect(source, `no source registered for ${serviceName} -- add it to SERVICE_SOURCES`).toBeDefined();
      // Either form is a real check; assertAuthorizedOrNotFound additionally
      // masks the denial as 404 on read paths (SR-009).
      expect(source).toMatch(/assertAuthorized(OrNotFound)?\(/);
    });
  }
});

/**
 * Upload endpoints must identify the caller before they read the body.
 *
 * Found against production: an anonymous POST carrying a `.exe` was answered
 * `415 File extension not allowed: .exe`, because readMultipartUpload and
 * validateUploadCandidate ran ahead of runAuthenticatedOperation. Nothing
 * leaked and nothing was written, but a stranger could spend the Worker's time
 * parsing arbitrary multipart bodies and read the upload policy back out of the
 * error — and could tell upload routes from every other route by 415 vs 401.
 *
 * Source inspection rather than a request, because the property is an ordering
 * one: a behavioural test sees 401 either way once the body happens to be
 * well-formed.
 */
describe("upload handlers authenticate before they parse", () => {
  const uploadHandlers = ["handleCreateDocumentDraft", "handleCreateDocumentVersion"];

  for (const handler of uploadHandlers) {
    it(`${handler} does not touch the body outside the authenticated handler`, () => {
      const body = ADMIN_DOCUMENTS_SOURCE.split(`export async function ${handler}`)[1] ?? "";
      expect(body, `${handler} not found`).not.toBe("");

      const preamble = body.split("handler: async (principal)")[0] ?? "";
      expect(preamble, `${handler} parses the request body before authenticating`).not.toContain("readMultipartUpload(");
      expect(preamble, `${handler} validates an upload before authenticating`).not.toContain("validateUploadCandidate(");

      // ...and still does both somewhere, so this cannot pass by dropping them.
      expect(body).toContain("readMultipartUpload(");
      expect(body).toContain("validateUploadCandidate(");
    });
  }
});
