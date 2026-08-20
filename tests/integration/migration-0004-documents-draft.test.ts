import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import migration0004 from "../../migrations/0004_documents_draft_permission.sql?raw";
import type { Env } from "../../src/env";
import { applySchema } from "../helpers/db";

const testEnv = env as unknown as Env;

/**
 * Migration 0004 against a database that already looks like production.
 *
 * A seed file describes a database nobody has yet. Production was seeded months
 * ago, so what actually matters is what the migration does to the taxonomy
 * that is already there — and that is exactly the step no seed test covers.
 *
 * The rows inserted below are the pre-migration taxonomy verbatim: the two
 * roles that hold document permissions, and the grants they had before SR-025.
 * The migration then runs, and the assertions describe the world afterwards.
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

beforeAll(async () => {
  // applySchema already includes 0004, so start from a database that has the
  // tables but none of the taxonomy, then rebuild the PRE-migration state by
  // hand and re-run 0004 over it. Re-running is itself part of what is under
  // test: `wrangler d1 migrations apply` must be safe to retry.
  await applySchema(testEnv.DB);

  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO permissions (id, key, description) VALUES
         ('perm_documents_write', 'documents.write', 'Create/update document drafts'),
         ('perm_admin_documents', 'admin.documents', 'Administrative document management'),
         ('perm_documents_publish', 'documents.publish', 'Publish/archive documents'),
         ('perm_documents_read_all', 'documents.read.*', 'Read documents in any domain')`
    ),
    testEnv.DB.prepare(
      `INSERT INTO roles (id, name, description) VALUES
         ('role_content_contributor', 'content-contributor', 'Drafts documents and submits them for human review.'),
         ('role_knowledge_admin', 'knowledge-admin', 'Xfeatures Athenaeum administrators.')`
    ),
    testEnv.DB.prepare(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES
         ('role_content_contributor', 'perm_documents_read_all'),
         ('role_content_contributor', 'perm_documents_write'),
         ('role_content_contributor', 'perm_admin_documents'),
         ('role_knowledge_admin', 'perm_documents_read_all'),
         ('role_knowledge_admin', 'perm_documents_write'),
         ('role_knowledge_admin', 'perm_admin_documents'),
         ('role_knowledge_admin', 'perm_documents_publish')`
    )
  ]);

  const executable = statements(migration0004);
  await testEnv.DB.batch(executable.map((s) => testEnv.DB.prepare(s)));
});

describe("migration 0004 on an already-seeded database", () => {
  it("adds the documents.draft permission", async () => {
    const row = await testEnv.DB.prepare("SELECT key FROM permissions WHERE key = 'documents.draft'").first<{ key: string }>();
    expect(row?.key).toBe("documents.draft");
  });

  it("leaves content-contributor able to propose", async () => {
    expect(await permissionKeysFor("content-contributor")).toContain("documents.draft");
  });

  it("takes away the corpus-wide edit and administrative reach it never needed", async () => {
    const keys = await permissionKeysFor("content-contributor");
    expect(keys).not.toContain("documents.write");
    expect(keys).not.toContain("admin.documents");
    // The read scope it uses to check what it is filing against is untouched.
    expect(keys).toContain("documents.read.*");
  });

  it("does not disarm the roles that are supposed to edit", async () => {
    const keys = await permissionKeysFor("knowledge-admin");
    // Gained the narrower permission...
    expect(keys).toContain("documents.draft");
    // ...without losing anything.
    expect(keys).toContain("documents.write");
    expect(keys).toContain("admin.documents");
    expect(keys).toContain("documents.publish");
  });

  it("re-describes documents.write as what it now means", async () => {
    const row = await testEnv.DB.prepare("SELECT description FROM permissions WHERE key = 'documents.write'").first<{
      description: string;
    }>();
    expect(row?.description).toContain("Revise an existing document");
  });

  it("is safe to run twice", async () => {
    const executable = statements(migration0004);
    await testEnv.DB.batch(executable.map((s) => testEnv.DB.prepare(s)));

    const keys = await permissionKeysFor("content-contributor");
    expect(keys).toContain("documents.draft");
    expect(keys).not.toContain("documents.write");
    expect(keys.filter((k) => k === "documents.draft")).toHaveLength(1);
  });
});
