import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import migration0008 from "../../migrations/0008_public_agent_public_knowledge.sql?raw";
import type { Env } from "../../src/env";
import { applySchema } from "../helpers/db";

const testEnv = env as unknown as Env;

/**
 * Migration 0008 against a database that already looks like production.
 *
 * The rows inserted below are the pre-migration production taxonomy for the
 * permissions and the one role this migration touches. The migration is then
 * run twice -- `wrangler d1 migrations apply` must be safe to retry -- and the
 * assertions describe the world afterwards.
 */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function permissionKeysFor(roleName: string): Promise<string[]> {
  const { results } = await testEnv.DB.prepare(
    `SELECT p.key AS key
       FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.name = ?1
      ORDER BY p.key`
  )
    .bind(roleName)
    .all<{ key: string }>();
  return results.map((r) => r.key);
}

async function runMigration(): Promise<void> {
  await testEnv.DB.batch(statements(migration0008).map((s) => testEnv.DB.prepare(s)));
}

beforeAll(async () => {
  // applySchema already includes 0008 (a no-op on an empty taxonomy apart from
  // the new permission row), so rebuild the PRE-migration state by hand and
  // re-run 0008 over it.
  await applySchema(testEnv.DB);

  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description) VALUES
         ('perm_knowledge_search', 'knowledge.search', 'Call semantic search'),
         ('perm_class_public', 'knowledge.classification.PUBLIC', 'May see PUBLIC-classified resources'),
         ('perm_class_internal', 'knowledge.classification.INTERNAL', 'May see INTERNAL-classified resources'),
         ('perm_facts_read_products', 'facts.read.products', 'Read facts in the products namespace'),
         ('perm_facts_read_plans', 'facts.read.plans', 'Read facts in the plans namespace'),
         ('perm_facts_read_services', 'facts.read.services', 'Read facts in the services namespace'),
         ('perm_facts_read_policies', 'facts.read.policies', 'Read facts in the policies namespace'),
         ('perm_documents_read_public', 'documents.read.public', 'Read documents in the public domain'),
         ('perm_documents_read_legal', 'documents.read.legal', 'Read documents in the legal domain'),
         ('perm_products_read', 'products.read', 'Deterministic product lookups'),
         ('perm_prices_read', 'prices.read', 'Deterministic price/plan lookups'),
         ('perm_feedback_submit', 'feedback.submit', 'Submit knowledge feedback')`
    ),
    testEnv.DB.prepare(
      `INSERT INTO roles (id, name, description) VALUES
         ('role_public_agent', 'public-agent', 'Public-facing chatbots. PUBLIC knowledge only.'),
         ('role_support_agent', 'support-agent', 'Internal support desk agents.')`
    ),
    testEnv.DB.prepare(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES
         ('role_public_agent', 'perm_knowledge_search'),
         ('role_public_agent', 'perm_class_public'),
         ('role_public_agent', 'perm_documents_read_public'),
         ('role_public_agent', 'perm_facts_read_products'),
         ('role_public_agent', 'perm_products_read'),
         ('role_public_agent', 'perm_feedback_submit'),
         ('role_support_agent', 'perm_class_public'),
         ('role_support_agent', 'perm_class_internal')`
    )
  ]);

  await runMigration();
  await runMigration();
});

describe("migration 0008 on an already-seeded database", () => {
  it("lets public-agent read the PUBLIC knowledge customers ask about", async () => {
    expect(await permissionKeysFor("public-agent")).toEqual([
      "documents.read.legal",
      "documents.read.public",
      "facts.read.network",
      "facts.read.plans",
      "facts.read.policies",
      "facts.read.products",
      "facts.read.services",
      "feedback.submit",
      "knowledge.classification.PUBLIC",
      "knowledge.search",
      "prices.read",
      "products.read"
    ]);
  });

  it("does not widen public-agent's classification beyond PUBLIC", async () => {
    const keys = await permissionKeysFor("public-agent");
    expect(keys.filter((k) => k.startsWith("knowledge.classification."))).toEqual(["knowledge.classification.PUBLIC"]);
    expect(keys.some((k) => k.startsWith("admin.") || k.endsWith(".*") || k.startsWith("network."))).toBe(false);
  });

  it("leaves every other role untouched", async () => {
    expect(await permissionKeysFor("support-agent")).toEqual([
      "knowledge.classification.INTERNAL",
      "knowledge.classification.PUBLIC"
    ]);
  });

  it("creates exactly one facts.read.network permission, even when re-run", async () => {
    const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM permissions WHERE key = 'facts.read.network'`).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
