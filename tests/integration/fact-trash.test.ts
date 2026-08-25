import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../../src/config";
import { FactsService } from "../../src/knowledge/facts";
import { purgeExpiredFacts } from "../../src/maintenance/purge-trash";
import { FactsRepository } from "../../src/repositories/facts.repository";
import { ApiError, ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import { createAgent, createFact, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

let admin: SeededAgent;
/** admin.facts, but only PUBLIC clearance and only the products namespace. */
let limitedAdmin: SeededAgent;
let repo: FactsRepository;
let facts: FactsService;

/**
 * The fact trash, on the model migration 0003 gave documents.
 *
 * Until now the only way to remove a fact was to deprecate it, which keeps the
 * row and every version forever. That is right for a superseded price and wrong
 * for something that should never have been filed -- a contact, a customer's
 * details, a credential typed into the wrong field. These tests pin the
 * properties that make the trash a safety net rather than a slower delete
 * button: it stops answering immediately, it comes back as what it was, and the
 * content is destroyed only by the scheduled purge once the window has closed.
 */
beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  admin = await createAgent(testEnv, "fact-admin", "knowledge-admin");
  limitedAdmin = await createAgent(testEnv, "fact-limited", "limited-fact-admin");
  repo = new FactsRepository(testEnv.DB);
  facts = new FactsService(repo);
});

// Each test starts from the same three facts: one the limited admin can read,
// one it cannot read for want of clearance, and one it cannot read at all.
beforeEach(async () => {
  await testEnv.DB.prepare("DELETE FROM fact_versions").run();
  await testEnv.DB.prepare("DELETE FROM facts").run();
  await testEnv.DB.prepare("DELETE FROM audit_events").run();
  await createFact(testEnv, "products", "widget-price", "PUBLIC", { amount: 10 });
  await createFact(testEnv, "plans", "annual-pro", "INTERNAL", { amount: 990 });
  await createFact(testEnv, "secrets", "master-key", "RESTRICTED", { value: "top-secret" });
});

describe("a trashed fact stops being knowledge immediately", () => {
  it("is no longer answerable by key", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);

    await expect(facts.getFact(admin.principal, "products", "widget-price")).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND
    });
  });

  it("is no longer returned by the namespace listing", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);

    const listed = await facts.getFacts(admin.principal, "products", 50, 0);
    expect(listed.map((fact) => fact.key)).not.toContain("widget-price");
  });

  it("reports itself as trashed rather than merely deprecated", async () => {
    const trashed = await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);
    expect(trashed.status).toBe("trashed");

    // The database stores what is true of it: deprecated, and going.
    const row = await repo.getTrashed("products", "widget-price");
    expect(row?.status).toBe("deprecated");
    expect(row?.trashed_at).not.toBeNull();
  });

  it("does not appear in the administrative listing either", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);

    const listed = await facts.listFactsForAdmin(admin.principal, { limit: 50, offset: 0 });
    expect(listed.map((fact) => fact.key)).not.toContain("widget-price");
  });
});

describe("restoring returns a fact to what it was, not to current", () => {
  it("brings an active fact back active", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);
    const restored = await facts.restoreFromTrash(admin.principal, "products", "widget-price", admin.agentId);

    expect(restored.status).toBe("active");
    await expect(facts.getFact(admin.principal, "products", "widget-price")).resolves.toMatchObject({
      key: "widget-price"
    });
  });

  it("brings a deprecated fact back deprecated, rather than republishing it", async () => {
    // Deprecation is a deliberate withdrawal. Restoring from the trash must not
    // become a way to undo it by accident.
    await repo.deprecate("plans", "annual-pro", admin.agentId);
    await facts.moveToTrash(admin.principal, "plans", "annual-pro", admin.agentId);

    const restored = await facts.restoreFromTrash(admin.principal, "plans", "annual-pro", admin.agentId);

    expect(restored.status).toBe("deprecated");
    await expect(facts.getFact(admin.principal, "plans", "annual-pro")).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND
    });
  });

  it("refuses to restore something that is not in the trash", async () => {
    await expect(
      facts.restoreFromTrash(admin.principal, "products", "widget-price", admin.agentId)
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("the retention window cannot be extended by trashing twice", () => {
  it("refuses the second call instead of resetting the clock", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);
    const first = await repo.getTrashed("products", "widget-price");

    await expect(
      facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId)
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

    const second = await repo.getTrashed("products", "widget-price");
    expect(second?.trashed_at).toBe(first?.trashed_at);
  });
});

describe("the trash is bounded by the caller's own clearance", () => {
  beforeEach(async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);
    await facts.moveToTrash(admin.principal, "secrets", "master-key", admin.agentId);
  });

  it("shows a full-clearance operator everything in it", async () => {
    const listed = await facts.listTrash(admin.principal, { limit: 50, offset: 0 });
    expect(listed.map((fact) => `${fact.namespace}/${fact.key}`).sort()).toEqual([
      "products/widget-price",
      "secrets/master-key"
    ]);
  });

  it("never shows a fact the caller could not read before it was deleted", async () => {
    // The regression that matters: deleting something must not make it visible
    // to someone who was never allowed to see it. This principal holds
    // admin.facts, so it reaches the listing -- and PUBLIC/products only, so
    // the RESTRICTED secret must not be in the answer.
    const listed = await facts.listTrash(limitedAdmin.principal, { limit: 50, offset: 0 });

    expect(listed.map((fact) => `${fact.namespace}/${fact.key}`)).toEqual(["products/widget-price"]);
    expect(JSON.stringify(listed)).not.toContain("top-secret");
    expect(JSON.stringify(listed)).not.toContain("master-key");
  });

  it("reports how long is left, computed from the retention window", async () => {
    const [entry] = await facts.listTrash(admin.principal, { limit: 1, offset: 0 });

    expect(entry).toBeDefined();
    expect(entry?.statusBeforeTrash).toBe("active");
    expect(Date.parse(entry?.purgeableAt ?? "")).toBeGreaterThan(Date.now());
    expect(entry?.minutesRemaining).toBeGreaterThan(0);
    expect(entry?.minutesRemaining).toBeLessThanOrEqual(LIMITS.TRASH_RETENTION_HOURS * 60);
  });
});

describe("the scheduled purge is the only thing that destroys a fact", () => {
  it("leaves a fact whose window is still open completely alone", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);

    const cutoff = new Date(Date.now() - LIMITS.TRASH_RETENTION_HOURS * 3600_000).toISOString();
    const outcome = await purgeExpiredFacts(testEnv, cutoff);

    expect(outcome.eligible).toBe(0);
    expect(await repo.getTrashed("products", "widget-price")).not.toBeNull();
  });

  it("destroys the fact and every version of it once the window has closed", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);

    // A fact that looks purged while its versions survive is the one outcome
    // this must never produce, so history is asserted separately from the row.
    const cutoff = new Date(Date.now() + 60_000).toISOString();
    const outcome = await purgeExpiredFacts(testEnv, cutoff);

    expect(outcome.purged).toEqual(["products/widget-price"]);
    expect(await repo.getTrashed("products", "widget-price")).toBeNull();

    const versions = await repo.listVersions("products", "widget-price");
    expect(versions).toEqual([]);
  });

  it("never purges a fact that is not in the trash", async () => {
    const cutoff = new Date(Date.now() + 60_000).toISOString();
    await purgeExpiredFacts(testEnv, cutoff);

    await expect(facts.getFact(admin.principal, "products", "widget-price")).resolves.toMatchObject({
      key: "widget-price"
    });
  });

  it("records what was destroyed without recording what it said", async () => {
    await facts.moveToTrash(admin.principal, "secrets", "master-key", admin.agentId);
    const cutoff = new Date(Date.now() + 60_000).toISOString();
    await purgeExpiredFacts(testEnv, cutoff);

    const { results } = await testEnv.DB.prepare(
      "SELECT action, resource_id, old_value_json FROM audit_events WHERE action = 'facts.purge'"
    ).all<{ action: string; resource_id: string; old_value_json: string }>();

    expect(results).toHaveLength(1);
    expect(results[0]?.resource_id).toBe("secrets/master-key");
    // The audit trail outlives the fact; a copy of the value inside it would
    // defeat the purge it is recording.
    expect(results[0]?.old_value_json ?? "").not.toContain("top-secret");
  });
});
