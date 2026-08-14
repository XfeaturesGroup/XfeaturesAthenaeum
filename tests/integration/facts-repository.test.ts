import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { FactsRepository } from "../../src/repositories/facts.repository";
import type { Env } from "../../src/env";
import { applySchema } from "../helpers/db";

const testEnv = env as unknown as Env;

beforeAll(async () => {
  await applySchema(testEnv.DB);
});

describe("FactsRepository against a real D1 instance", () => {
  it("round-trips a fact through prepared statements", async () => {
    const repo = new FactsRepository(testEnv.DB);
    await repo.create({
      namespace: "products",
      key: "widget-a",
      valueJson: JSON.stringify({ name: "Widget A" }),
      classification: "PUBLIC",
      createdBy: "test-admin"
    });

    const fact = await repo.getActive("products", "widget-a");
    expect(fact).not.toBeNull();
    expect(fact?.version).toBe(1);
    expect(JSON.parse(fact?.value_json ?? "null")).toEqual({ name: "Widget A" });
  });

  it("bumps the version and writes a fact_versions row on update", async () => {
    const repo = new FactsRepository(testEnv.DB);
    await repo.create({
      namespace: "products",
      key: "widget-b",
      valueJson: JSON.stringify({ name: "Widget B" }),
      classification: "PUBLIC",
      createdBy: "test-admin"
    });

    await repo.update("products", "widget-b", { title: "Widget B (renamed)", updatedBy: "test-admin" });
    const updated = await repo.getActive("products", "widget-b");
    expect(updated?.version).toBe(2);
    expect(updated?.title).toBe("Widget B (renamed)");

    const versions = await repo.listVersions("products", "widget-b");
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  /**
   * (SQL injection): every repository query uses parameter
   * binding (`?1`, `?2`, ...), never string concatenation. A classic
   * injection payload used as a *value* must be stored and retrieved
   * literally -- never alter query semantics or affect other rows.
   */
  it("treats a SQL-injection-shaped key as an inert literal string", async () => {
    const repo = new FactsRepository(testEnv.DB);
    const maliciousKey = "x'; DROP TABLE facts; --";

    await repo.create({
      namespace: "security-test",
      key: maliciousKey,
      valueJson: JSON.stringify({ probe: true }),
      classification: "PUBLIC",
      createdBy: "test-admin"
    });

    // If the payload had been concatenated into SQL, this table would now be
    // gone and every prior assertion's data would be unreachable.
    const stillThere = await repo.getActive("products", "widget-a");
    expect(stillThere).not.toBeNull();

    const literal = await repo.getActive("security-test", maliciousKey);
    expect(literal).not.toBeNull();
    expect(literal?.key).toBe(maliciousKey);
  });

  it("getActive returns null for an unknown namespace/key rather than throwing", async () => {
    const repo = new FactsRepository(testEnv.DB);
    const missing = await repo.getActive("nonexistent", "nonexistent");
    expect(missing).toBeNull();
  });

  // Rollback restores prior content as a *new* version -- it
  // never rewrites history.
  it("rollbackToVersion restores v1's content under a fresh version number", async () => {
    const repo = new FactsRepository(testEnv.DB);
    await repo.create({
      namespace: "products",
      key: "widget-c",
      valueJson: JSON.stringify({ price: 10 }),
      title: "Original title",
      classification: "PUBLIC",
      createdBy: "test-admin"
    });
    await repo.update("products", "widget-c", { valueJson: JSON.stringify({ price: 999 }), title: "Bad edit", updatedBy: "test-admin" });

    const beforeRollback = await repo.getActive("products", "widget-c");
    expect(beforeRollback?.version).toBe(2);
    expect(JSON.parse(beforeRollback?.value_json ?? "null")).toEqual({ price: 999 });

    const rolledBack = await repo.rollbackToVersion("products", "widget-c", 1, "test-admin");
    expect(rolledBack.version).toBe(3); // a new version, not v1 rewritten
    expect(rolledBack.title).toBe("Original title");
    expect(JSON.parse(rolledBack.value_json)).toEqual({ price: 10 });

    const versions = await repo.listVersions("products", "widget-c");
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3]);
    const v1 = versions.find((v) => v.version === 1);
    expect(JSON.parse(v1?.value_json ?? "null")).toEqual({ price: 10 }); // v1 itself untouched
  });
});
