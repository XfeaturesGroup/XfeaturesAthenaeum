// Tests run inside the actual workerd sandbox (via @cloudflare/vitest-pool-workers),
// which has no host filesystem access -- `node:fs` can't read migration files at
// runtime. Vite's `?raw` import inlines their contents at build/transform time
// instead, so no runtime FS call happens at all.
//
// Every migration must be listed here, in order. A missing entry means tests
// run against a schema that production does not have.
import migration0001 from "../../migrations/0001_init.sql?raw";
import migration0002 from "../../migrations/0002_account_identity_link.sql?raw";
import migration0003 from "../../migrations/0003_document_trash.sql?raw";

const MIGRATIONS: readonly string[] = [migration0001, migration0002, migration0003];

/**
 * D1's `db.exec()` parses its input close to line-by-line and chokes on
 * comment-only lines, so each migration is split into individual statements and
 * run through `db.batch()` instead -- the same thing
 * `wrangler d1 migrations apply` does under the hood.
 */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export async function applySchema(db: D1Database): Promise<void> {
  for (const migration of MIGRATIONS) {
    const statements = splitStatements(migration);
    // PRAGMA statements are not meaningful inside a D1 batch and the table
    // rebuilds in 0002 and 0003 do not need them here (the batch is already atomic).
    const executable = statements.filter((statement) => !/^PRAGMA\b/i.test(statement));
    await db.batch(executable.map((statement) => db.prepare(statement)));
  }
}
