#!/usr/bin/env node
/**
 * The production seed is the development seed with its synthetic catalogue
 * removed. Two failure modes matter, in opposite directions:
 *
 *   - the taxonomy drifts, so production gets a different permission
 *     vocabulary than every test ran against;
 *   - fixture data leaks forward, so a demo product ends up in a real
 *     knowledge base.
 *
 * This checks both, and is cheap enough to run on every build.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dev = readFileSync(join(root, "seed/dev-seed.sql"), "utf8");
const prod = readFileSync(join(root, "seed/production-seed.sql"), "utf8");

const SPLIT = "-- Synthetic catalog fixtures";
/** Tables that describe the business or its principals. Never seeded. */
const FORBIDDEN = ["facts", "products", "plans", "policies", "knowledge_sources", "agents", "agent_roles"];

const failures = [];

if (!dev.includes(SPLIT)) {
  failures.push(`dev-seed.sql no longer contains the "${SPLIT}" marker, so the split point is undefined.`);
}

for (const table of FORBIDDEN) {
  if (new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, "i").test(prod)) {
    failures.push(`production-seed.sql inserts into "${table}" — production carries no fixture or principal data.`);
  }
}

/**
 * Compare the taxonomy itself rather than the surrounding prose, so a reworded
 * comment does not fail the build but a changed permission does.
 */
const statements = (sql) =>
  sql
    .slice(0, sql.includes(SPLIT) ? sql.indexOf(SPLIT) : undefined)
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => /^INSERT\s+INTO/i.test(s));

const devTaxonomy = statements(dev);
const prodTaxonomy = statements(prod);

if (devTaxonomy.length !== prodTaxonomy.length) {
  failures.push(`taxonomy statement count differs: dev has ${devTaxonomy.length}, production has ${prodTaxonomy.length}.`);
} else {
  for (let i = 0; i < devTaxonomy.length; i++) {
    if (devTaxonomy[i] !== prodTaxonomy[i]) {
      const target = devTaxonomy[i].match(/INSERT\s+INTO\s+(\w+)/i)?.[1] ?? "?";
      failures.push(`taxonomy for "${target}" differs between dev-seed.sql and production-seed.sql.`);
    }
  }
}

if (failures.length > 0) {
  console.error("Seed parity check failed:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("");
  process.exit(1);
}

console.log(`Seeds agree: ${prodTaxonomy.length} taxonomy statement(s), no fixture or principal data in production.`);
