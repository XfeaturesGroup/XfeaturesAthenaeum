import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { buildServices, type Services } from "../../src/api/services";
import { assertCanAccessFact, assertCanReclassifyFact, assertCanReclassifyDocument, assertCanGrantRole } from "../../src/auth/resource-guard";
import ADMIN_DOCUMENTS_SOURCE from "../../src/api/routes/admin/documents.ts?raw";
import DOCUMENTS_SERVICE_SOURCE from "../../src/knowledge/documents.ts?raw";
import ADMIN_SCHEMAS_SOURCE from "../../src/api/schemas/admin.ts?raw";
import { authorize } from "../../src/auth/authorize";
import { ApiError, ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import { createAgent, createFact, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

let publicAgent: SeededAgent;
let supportAgent: SeededAgent;
let limitedFactAdmin: SeededAgent;
let knowledgeAdmin: SeededAgent;
let services: Services;

beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  publicAgent = await createAgent(testEnv, "esc-public", "public-agent");
  supportAgent = await createAgent(testEnv, "esc-support", "support-agent");
  limitedFactAdmin = await createAgent(testEnv, "esc-limited-admin", "limited-fact-admin");
  knowledgeAdmin = await createAgent(testEnv, "esc-admin", "knowledge-admin");
  services = buildServices(testEnv);

  await createFact(testEnv, "secrets", "master-key", "RESTRICTED", { value: "top-secret" });
  await createFact(testEnv, "plans", "enterprise", "CONFIDENTIAL", { price: 99999 });
  await createFact(testEnv, "products", "widget", "PUBLIC", { name: "Widget" });
});

function expectDenied(fn: () => unknown, expectedPublicCode: ErrorCode = ErrorCode.NOT_FOUND): void {
  try {
    fn();
    throw new Error("Expected an authorization denial, but the call succeeded.");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    // The true reason stays FORBIDDEN for the audit trail...
    expect(apiError.code).toBe(ErrorCode.FORBIDDEN);
    // ...while the client-facing code hides resource existence.
    expect(apiError.publicCode).toBe(expectedPublicCode);
  }
}

/**
 * SR-002 / SR-003 regression. An `admin.facts` holder is authorized to
 * operate on facts as a KIND of resource. It must not thereby gain access to
 * an individual fact above its classification ceiling, and must not be able
 * to launder one down to a tier it can read.
 */
describe("SR-002: admin write permission does not confer resource access", () => {
  it("a limited fact admin cannot touch a RESTRICTED fact it cannot read", () => {
    expectDenied(() => {
      assertCanAccessFact(limitedFactAdmin.principal, "secrets", "RESTRICTED");
    });
  });

  it("a limited fact admin CAN touch a PUBLIC fact in a namespace it holds", () => {
    expect(() => {
      assertCanAccessFact(limitedFactAdmin.principal, "products", "PUBLIC");
    }).not.toThrow();
  });

  it("a full knowledge admin can touch a RESTRICTED fact", () => {
    expect(() => {
      assertCanAccessFact(knowledgeAdmin.principal, "secrets", "RESTRICTED");
    }).not.toThrow();
  });
});

describe("SR-003: classification downgrade requires holding both tiers", () => {
  it("blocks downgrading RESTRICTED -> PUBLIC when the actor lacks RESTRICTED", () => {
    expectDenied(() => {
      assertCanReclassifyFact(limitedFactAdmin.principal, "secrets", "RESTRICTED", "PUBLIC");
    });
  });

  it("blocks upgrading PUBLIC -> RESTRICTED when the actor lacks RESTRICTED", () => {
    // Writing INTO a tier you cannot hold is also refused: it would let an
    // actor hide data from itself and from its own audit scope.
    expectDenied(() => {
      assertCanReclassifyFact(limitedFactAdmin.principal, "products", "PUBLIC", "RESTRICTED");
    });
  });

  it("allows a no-op reclassification within a held tier", () => {
    expect(() => {
      assertCanReclassifyFact(limitedFactAdmin.principal, "products", "PUBLIC", "PUBLIC");
    }).not.toThrow();
  });

  it("allows a full admin to reclassify across tiers it holds", () => {
    expect(() => {
      assertCanReclassifyFact(knowledgeAdmin.principal, "secrets", "RESTRICTED", "INTERNAL");
    }).not.toThrow();
  });
});

describe("vertical escalation attempts all end in DENY", () => {
  const escalations: { name: string; principal: () => SeededAgent; action: Parameters<typeof authorize>[1] }[] = [
    { name: "public-agent -> admin.agents", principal: () => publicAgent, action: { action: "admin.agents" } },
    { name: "public-agent -> admin.facts", principal: () => publicAgent, action: { action: "admin.facts" } },
    { name: "public-agent -> audit.read", principal: () => publicAgent, action: { action: "audit.read" } },
    { name: "public-agent -> documents.publish", principal: () => publicAgent, action: { action: "documents.publish" } },
    { name: "public-agent -> admin.ingestion", principal: () => publicAgent, action: { action: "admin.ingestion" } },
    { name: "support-agent -> admin.agents", principal: () => supportAgent, action: { action: "admin.agents" } },
    { name: "support-agent -> admin.facts", principal: () => supportAgent, action: { action: "admin.facts" } },
    { name: "support-agent -> network.read", principal: () => supportAgent, action: { action: "network.read" } },
    { name: "limited-fact-admin -> admin.agents", principal: () => limitedFactAdmin, action: { action: "admin.agents" } },
    { name: "limited-fact-admin -> audit.read", principal: () => limitedFactAdmin, action: { action: "audit.read" } }
  ];

  for (const escalation of escalations) {
    it(escalation.name, () => {
      const result = authorize(escalation.principal().principal, escalation.action);
      expect(result.allowed).toBe(false);
    });
  }
});

describe("horizontal escalation: knowing an identifier grants nothing", () => {
  it("a public agent cannot read a RESTRICTED fact even with the exact namespace/key", async () => {
    await expect(services.facts.getFact(publicAgent.principal, "secrets", "master-key")).rejects.toThrow(ApiError);
  });

  it("the denial is reported as NOT_FOUND so existence is not disclosed (SR-009)", async () => {
    try {
      await services.facts.getFact(publicAgent.principal, "secrets", "master-key");
      throw new Error("expected denial");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.publicCode).toBe(ErrorCode.NOT_FOUND);
    }
  });

  it("a genuinely missing fact is indistinguishable from a forbidden one", async () => {
    let forbiddenCode: string | undefined;
    let missingCode: string | undefined;
    try {
      await services.facts.getFact(publicAgent.principal, "secrets", "master-key");
    } catch (error) {
      forbiddenCode = (error as ApiError).publicCode;
    }
    try {
      await services.facts.getFact(publicAgent.principal, "secrets", "does-not-exist-at-all");
    } catch (error) {
      missingCode = (error as ApiError).publicCode;
    }
    expect(forbiddenCode).toBe(missingCode);
    expect(forbiddenCode).toBe(ErrorCode.NOT_FOUND);
  });

  it("a support agent cannot read a CONFIDENTIAL plan fact it lacks the tier for", async () => {
    await expect(services.facts.getFact(supportAgent.principal, "plans", "enterprise")).rejects.toThrow(ApiError);
  });

  it("an authorized agent still reads what it legitimately holds", async () => {
    const fact = await services.facts.getFact(publicAgent.principal, "products", "widget");
    expect(fact.value).toEqual({ name: "Widget" });
  });
});

/**
 * SR from the HQ access-management build: role grants (agent creation and
 * role assignment alike) must never hand out a permission the granting
 * principal does not itself hold. Wildcard-aware, mirroring how the
 * permission check itself resolves a wildcard grant.
 */
describe("role grants cannot escalate privilege", () => {
  it("a public agent cannot grant a role carrying admin.agents", () => {
    expect(() => assertCanGrantRole(publicAgent.principal, ["admin.agents"])).toThrow(ApiError);
  });

  it("a limited-fact-admin cannot grant audit.read, which it does not hold", () => {
    expect(() => assertCanGrantRole(limitedFactAdmin.principal, ["audit.read"])).toThrow(ApiError);
  });

  it("the denial reason is PRIVILEGE_ESCALATION_BLOCKED", () => {
    try {
      assertCanGrantRole(publicAgent.principal, ["admin.agents"]);
      throw new Error("expected a denial");
    } catch (error) {
      expect((error as ApiError).details).toMatchObject({ authzReason: "PRIVILEGE_ESCALATION_BLOCKED" });
    }
  });

  it("a wildcard grant covers a narrower permission without enumerating it", () => {
    // knowledge-admin holds documents.read.* -- granting documents.read.support
    // specifically must be allowed without that exact string ever being listed.
    expect(() => assertCanGrantRole(knowledgeAdmin.principal, ["documents.read.support"])).not.toThrow();
  });

  it("a full knowledge admin can grant any single permission it holds", () => {
    expect(() => assertCanGrantRole(knowledgeAdmin.principal, ["admin.agents"])).not.toThrow();
  });

  it("granting a role is blocked the moment ANY one of its permissions escalates", () => {
    // supportAgent holds knowledge.search + a couple of documents.read.* grants,
    // but not admin.facts -- a role bundling one held and one unheld permission
    // must still be refused in full, not partially granted.
    expect(() => assertCanGrantRole(supportAgent.principal, ["knowledge.search", "admin.facts"])).toThrow(ApiError);
  });
});

describe("SR-008: deprecated facts are never served as current", () => {
  it("a deprecated fact disappears from both the single-fact and list endpoints", async () => {
    await createFact(testEnv, "products", "retired-widget", "PUBLIC", { name: "Retired" });
    await services.factsRepo.deprecate("products", "retired-widget", "test");

    await expect(services.facts.getFact(publicAgent.principal, "products", "retired-widget")).rejects.toThrow(ApiError);

    const listed = await services.facts.getFacts(publicAgent.principal, "products", 50, 0);
    expect(listed.map((f) => f.key)).not.toContain("retired-widget");
  });
});

/**
 * SR-023: documents are reclassifiable too -- rolling back restores the target
 * version's classification, which may be stricter or looser than the current
 * one. The rule is identical to facts (hold BOTH tiers), but for a while the
 * document helper was exported and never called: rollback re-implemented the
 * check inline. That is how a shared rule silently becomes two rules, and then
 * one of them gets it wrong.
 *
 * Not exploitable when found -- the inline pair was correct, and the only
 * other path that can change a document's classification
 * (DocumentsRepository.createNewVersion) is not reachable from any transport.
 * Pinned here so it stays that way.
 */
describe("SR-023: document reclassification requires holding both tiers", () => {
  it("blocks rolling back INTO a tier the actor does not hold", () => {
    expectDenied(() => {
      assertCanReclassifyDocument(limitedFactAdmin.principal, "public", "PUBLIC", "RESTRICTED");
    });
  });

  it("blocks rolling back OUT OF a tier the actor cannot currently read", () => {
    expectDenied(() => {
      assertCanReclassifyDocument(limitedFactAdmin.principal, "public", "RESTRICTED", "PUBLIC");
    });
  });

  it("allows a full admin to reclassify across tiers it holds", () => {
    expect(() => {
      assertCanReclassifyDocument(knowledgeAdmin.principal, "support", "RESTRICTED", "INTERNAL");
    }).not.toThrow();
  });

  it("the rollback route actually routes through the shared guard", () => {
    // A behavioural test cannot tell the shared guard from an equivalent
    // inline pair, and the inline pair is exactly what drifted. Pin the call.
    const body = ADMIN_DOCUMENTS_SOURCE.split("export async function handleRollbackDocument")[1] ?? "";
    expect(body).toContain("assertCanReclassifyDocument(");
  });

  /**
   * Editing reaches DocumentsRepository.createNewVersion, which CAN set
   * `classification`. The note above used to say that path was unreachable
   * from any transport; POST /v1/admin/documents/:id/versions makes it
   * reachable, so the property has to be enforced rather than assumed.
   *
   * The service is the chokepoint: it inherits the current tier and never
   * forwards a caller-supplied classification. If that ever changes, editing
   * silently becomes an unguarded reclassification -- the exact shape of
   * SR-023, with no assertCanReclassifyDocument anywhere near it.
   */
  it("editing cannot reclassify: the service never forwards a classification", () => {
    const body = DOCUMENTS_SERVICE_SOURCE.split("async createNewVersion(")[1]?.split("\n  async ")[0] ?? "";
    expect(body).not.toMatch(/classification:\s*(input|metadata|params)\./);
    // The repository call inside it must not pass classification at all.
    const repoCall = body.split("this.repo.createNewVersion(")[1]?.split("});")[0] ?? "";
    expect(repoCall).not.toContain("classification");
  });

  it("the edit route does not accept a classification field", () => {
    const schema = ADMIN_SCHEMAS_SOURCE.split("createDocumentVersionMetadataSchema")[1]?.split("});")[0] ?? "";
    expect(schema).not.toContain("classification");
    expect(schema).not.toContain("domain");
    // Optimistic concurrency is the point of the schema; losing it turns a
    // concurrent edit into a silent overwrite.
    expect(schema).toContain("expected_version");
  });
});
