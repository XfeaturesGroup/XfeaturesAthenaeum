import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FactsService } from "../../src/knowledge/facts";
import { FactsRepository } from "../../src/repositories/facts.repository";
import { ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import { createAgent, createFact, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

let admin: SeededAgent;
/** admin.facts, but only PUBLIC clearance and only the products namespace. */
let limitedAdmin: SeededAgent;
/** No administrative permission at all. */
let reader: SeededAgent;
let repo: FactsRepository;
let facts: FactsService;

/**
 * Reading facts across namespaces, which is what the console needs to offer
 * "all facts" at all.
 *
 * HQ previously shipped a hardcoded list of six namespaces, so anything filed
 * outside them was invisible to every operator while being perfectly readable
 * over the API. The fix is a listing -- and a listing that spans namespaces is
 * exactly the shape that leaks if its bounds are wrong, so most of what is
 * pinned here is what it must NOT return.
 */
beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  admin = await createAgent(testEnv, "listing-admin", "knowledge-admin");
  limitedAdmin = await createAgent(testEnv, "listing-limited", "limited-fact-admin");
  reader = await createAgent(testEnv, "listing-reader", "support-agent");
  repo = new FactsRepository(testEnv.DB);
  facts = new FactsService(repo);
});

beforeEach(async () => {
  await testEnv.DB.prepare("DELETE FROM fact_versions").run();
  await testEnv.DB.prepare("DELETE FROM facts").run();
  await createFact(testEnv, "products", "widget-price", "PUBLIC", { amount: 10 });
  await createFact(testEnv, "products", "gadget-price", "PUBLIC", { amount: 25 });
  await createFact(testEnv, "products", "internal-margin", "CONFIDENTIAL", { margin: 0.4 });
  await createFact(testEnv, "plans", "annual-pro", "INTERNAL", { amount: 990, currency: "EUR" });
  await createFact(testEnv, "secrets", "master-key", "RESTRICTED", { value: "top-secret" });
});

describe("the namespace listing is a projection of the caller's own permissions", () => {
  it("names every namespace a full-clearance operator can read", async () => {
    const namespaces = await facts.listNamespaces(admin.principal);

    expect(namespaces.map((entry) => entry.namespace)).toEqual(["plans", "products", "secrets"]);
    expect(namespaces.find((entry) => entry.namespace === "products")?.factCount).toBe(3);
  });

  it("omits a namespace the caller cannot read, rather than showing it empty", async () => {
    // An empty entry would still be a directory of what exists behind a
    // permission the caller does not hold.
    const namespaces = await facts.listNamespaces(limitedAdmin.principal);

    expect(namespaces.map((entry) => entry.namespace)).toEqual(["products"]);
  });

  it("counts only what the caller may see, so a total cannot disclose the rest", async () => {
    // products holds three facts; this principal has PUBLIC clearance only, so
    // the CONFIDENTIAL margin must not be counted -- a total of 3 would tell it
    // a fact exists that it will never be shown.
    const namespaces = await facts.listNamespaces(limitedAdmin.principal);

    expect(namespaces.find((entry) => entry.namespace === "products")?.factCount).toBe(2);
  });

  it("excludes trashed facts from the count", async () => {
    await facts.moveToTrash(admin.principal, "products", "widget-price", admin.agentId);

    const namespaces = await facts.listNamespaces(admin.principal);
    expect(namespaces.find((entry) => entry.namespace === "products")?.factCount).toBe(2);
  });
});

describe("the administrative listing spans namespaces without widening anyone's reach", () => {
  it("requires the administrative permission to reach at all", async () => {
    await expect(facts.listFactsForAdmin(reader.principal, { limit: 50, offset: 0 })).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });

  it("returns facts from every namespace the caller can read", async () => {
    const listed = await facts.listFactsForAdmin(admin.principal, { limit: 50, offset: 0 });

    expect(listed.map((fact) => `${fact.namespace}/${fact.key}`).sort()).toEqual([
      "plans/annual-pro",
      "products/gadget-price",
      "products/internal-margin",
      "products/widget-price",
      "secrets/master-key"
    ]);
  });

  it("never returns a row the caller could not read individually", async () => {
    // admin.facts is what makes the listing reachable. It is not what decides
    // which rows come back -- that is still the per-row decision, and this
    // principal holds neither the CONFIDENTIAL tier nor the other namespaces
    // (SR-002/SR-003).
    const listed = await facts.listFactsForAdmin(limitedAdmin.principal, { limit: 50, offset: 0 });

    expect(listed.map((fact) => `${fact.namespace}/${fact.key}`).sort()).toEqual([
      "products/gadget-price",
      "products/widget-price"
    ]);
    expect(JSON.stringify(listed)).not.toContain("top-secret");
    expect(JSON.stringify(listed)).not.toContain("margin");
  });

  it("treats the namespace parameter as a narrowing, never a widening", async () => {
    // Asking for a namespace outside the caller's scope answers with nothing --
    // it does not reach into it.
    const listed = await facts.listFactsForAdmin(limitedAdmin.principal, {
      namespace: "secrets",
      limit: 50,
      offset: 0
    });

    expect(listed).toEqual([]);
  });

  it("includes deprecated facts, which every ordinary read path hides", async () => {
    await repo.deprecate("products", "gadget-price", admin.agentId);

    const all = await facts.listFactsForAdmin(admin.principal, { limit: 50, offset: 0 });
    expect(all.find((fact) => fact.key === "gadget-price")?.status).toBe("deprecated");

    const onlyDeprecated = await facts.listFactsForAdmin(admin.principal, {
      status: "deprecated",
      limit: 50,
      offset: 0
    });
    expect(onlyDeprecated.map((fact) => fact.key)).toEqual(["gadget-price"]);
  });

  it("searches the key, the title and the stored value", async () => {
    const byKey = await facts.listFactsForAdmin(admin.principal, { query: "annual", limit: 50, offset: 0 });
    expect(byKey.map((fact) => fact.key)).toEqual(["annual-pro"]);

    const byValue = await facts.listFactsForAdmin(admin.principal, { query: "EUR", limit: 50, offset: 0 });
    expect(byValue.map((fact) => fact.key)).toEqual(["annual-pro"]);
  });

  it("takes a search term literally, wildcards included", async () => {
    await createFact(testEnv, "products", "50_off", "PUBLIC", { discount: 0.5 });
    await createFact(testEnv, "products", "5000ff", "PUBLIC", { discount: 0 });

    // LIKE would read the underscore as "any character" and match both.
    const listed = await facts.listFactsForAdmin(admin.principal, { query: "50_off", limit: 50, offset: 0 });
    expect(listed.map((fact) => fact.key)).toEqual(["50_off"]);
  });

  it("answers in the client-facing shape, not the database row", async () => {
    const [fact] = await facts.listFactsForAdmin(admin.principal, { namespace: "plans", limit: 1, offset: 0 });

    expect(fact).toBeDefined();
    expect(Object.keys(fact ?? {}).sort()).toEqual(
      [
        "classification",
        "description",
        "key",
        "namespace",
        "sourceId",
        "status",
        "title",
        "updatedAt",
        "validFrom",
        "validUntil",
        "value",
        "version"
      ].sort()
    );
    // The value arrives parsed, not as a JSON string in a JSON response.
    expect(fact?.value).toEqual({ amount: 990, currency: "EUR" });
  });
});

describe("fact history", () => {
  it("lists every version, newest first, marking the current one", async () => {
    await repo.update("plans", "annual-pro", { valueJson: JSON.stringify({ amount: 1090 }), updatedBy: admin.agentId });

    const versions = await facts.listVersions(admin.principal, "plans", "annual-pro");

    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions[0]?.isCurrent).toBe(true);
    expect(versions[1]?.isCurrent).toBe(false);
    // The old value is the whole point: it is what an operator is deciding
    // whether to bring back.
    expect(versions[1]?.value).toEqual({ amount: 990, currency: "EUR" });
  });

  it("does not disclose the history of a fact the caller may not read", async () => {
    await expect(facts.listVersions(limitedAdmin.principal, "secrets", "master-key")).rejects.toMatchObject({
      // The audit trail records a truthful denial; the client is told
      // NOT_FOUND, because a 403 here would confirm the fact exists.
      code: ErrorCode.FORBIDDEN,
      publicCode: ErrorCode.NOT_FOUND
    });
  });

  it("still answers for a deprecated fact, which is when it is most needed", async () => {
    await repo.deprecate("plans", "annual-pro", admin.agentId);

    const versions = await facts.listVersions(admin.principal, "plans", "annual-pro");
    expect(versions.length).toBeGreaterThan(0);
  });
});
