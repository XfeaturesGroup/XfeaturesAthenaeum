#!/usr/bin/env node
/**
 * Applies this repository's AI Search custom metadata schema to a live
 * instance.
 *
 * Why this exists: the retrieval ACL filter references metadata attributes by
 * name, and AI Search only extracts attributes that are declared on the
 * instance. An undeclared attribute silently matches nothing, so a schema that
 * drifts from the code turns the pre-retrieval filter into dead weight.
 * `wrangler ai-search update` cannot set `custom_metadata`, so this calls the
 * REST API directly with the same schema the Worker imports.
 *
 * Credentials are read from the environment or from the local Wrangler login,
 * exactly as `wrangler` itself does. Nothing is written to disk and no token
 * value is ever printed.
 *
 * Usage:
 *   node scripts/configure-ai-search.mjs [--instance <name>] [--namespace <ns>] [--dry-run]
 *
 * Auth (first match wins):
 *   CLOUDFLARE_API_TOKEN   an API token with AI Search:Edit and AI Search:Run
 *   the existing `wrangler login` OAuth token
 *
 * Account id: CLOUDFLARE_ACCOUNT_ID, else discovered from the API.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "src", "search", "ai-search.metadata.json");
const API_BASE = "https://api.cloudflare.com/client/v4";

/** AI Search reserves these attribute names for its built-in extraction. */
const RESERVED_FIELD_NAMES = new Set(["timestamp", "folder", "filename"]);
const MAX_CUSTOM_FIELDS = 5;
const VALID_DATA_TYPES = new Set(["text", "number", "boolean", "datetime"]);

function parseArgs(argv) {
  const args = { instance: "xfeatures-athenaeum", namespace: "default", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--instance") args.instance = argv[++i];
    else if (flag === "--namespace") args.namespace = argv[++i];
    else if (flag === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.instance) throw new Error("--instance requires a value");
  return args;
}

/**
 * Reads the Wrangler OAuth token from the local login. Returned to the caller
 * for use in an Authorization header only; never logged.
 */
async function readWranglerOAuthToken() {
  const candidates = [
    path.join(homedir(), ".wrangler", "config", "default.toml"),
    path.join(process.env.APPDATA ?? "", "xdg.config", ".wrangler", "config", "default.toml"),
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), ".wrangler", "config", "default.toml")
  ];

  for (const candidate of candidates) {
    let contents;
    try {
      contents = await readFile(candidate, "utf8");
    } catch {
      continue;
    }
    const match = /^\s*oauth_token\s*=\s*"([^"]+)"/m.exec(contents);
    if (match) return match[1];
  }
  return null;
}

async function resolveAuth() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return { token: process.env.CLOUDFLARE_API_TOKEN, source: "CLOUDFLARE_API_TOKEN" };
  }
  const oauth = await readWranglerOAuthToken();
  if (oauth) return { token: oauth, source: "wrangler login" };

  throw new Error(
    "No Cloudflare credentials found. Set CLOUDFLARE_API_TOKEN (AI Search:Edit + AI Search:Run), or run `npx wrangler login`."
  );
}

async function callApi(token, method, endpoint, body) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${endpoint} returned non-JSON (HTTP ${response.status})`);
  }

  if (!response.ok || payload.success === false) {
    const detail = (payload.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${method} ${endpoint} failed (HTTP ${response.status})${detail ? ` -- ${detail}` : ""}`);
  }
  return payload.result;
}

async function resolveAccountId(token) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;

  const accounts = await callApi(token, "GET", "/accounts?per_page=50");
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("No accounts visible to these credentials.");
  }
  if (accounts.length > 1) {
    throw new Error(
      `These credentials can see ${accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID to choose one explicitly.`
    );
  }
  return accounts[0].id;
}

function validateSchema(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("custom_metadata must be a non-empty array.");
  }
  if (fields.length > MAX_CUSTOM_FIELDS) {
    throw new Error(`AI Search allows at most ${MAX_CUSTOM_FIELDS} custom attributes; the schema declares ${fields.length}.`);
  }
  const seen = new Set();
  for (const field of fields) {
    const { field_name: name, data_type: type } = field;
    if (typeof name !== "string" || name.length === 0) throw new Error("Every field needs a field_name.");
    if (name !== name.toLowerCase()) throw new Error(`Attribute names are stored lowercase; "${name}" is not.`);
    if (RESERVED_FIELD_NAMES.has(name)) throw new Error(`"${name}" is a reserved built-in attribute.`);
    if (seen.has(name)) throw new Error(`Duplicate attribute "${name}".`);
    if (!VALID_DATA_TYPES.has(type)) throw new Error(`Attribute "${name}" has an unsupported data_type "${type}".`);
    seen.add(name);
  }
}

function sameSchema(a, b) {
  const normalize = (fields) =>
    [...(fields ?? [])]
      .map((f) => `${f.field_name}:${f.data_type}`)
      .sort()
      .join(",");
  return normalize(a) === normalize(b);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
  const fields = schema.custom_metadata;
  validateSchema(fields);

  console.log(`Schema (${fields.length}/${MAX_CUSTOM_FIELDS} attributes):`);
  for (const field of fields) console.log(`  ${field.field_name} : ${field.data_type}`);

  if (args.dryRun) {
    console.log("\n--dry-run: nothing sent.");
    return;
  }

  const { token, source } = await resolveAuth();
  console.log(`\nAuthenticating via ${source}.`);
  const accountId = await resolveAccountId(token);
  const endpoint = `/accounts/${accountId}/ai-search/namespaces/${args.namespace}/instances/${args.instance}`;

  const before = await callApi(token, "GET", endpoint);
  if (sameSchema(before.custom_metadata, fields)) {
    console.log(`Instance "${args.instance}" already carries this schema. No change.`);
  } else {
    await callApi(token, "PUT", endpoint, { custom_metadata: fields });
    console.log(`Applied schema to "${args.instance}".`);
  }

  const after = await callApi(token, "GET", endpoint);
  if (!sameSchema(after.custom_metadata, fields)) {
    throw new Error("The instance did not accept the schema; its custom_metadata still differs.");
  }

  // These are security-relevant instance settings, not cosmetic ones. Report
  // them rather than assuming, so a drifted instance is visible immediately.
  console.log("\nInstance state:");
  console.log(`  custom_metadata      ${after.custom_metadata.map((f) => f.field_name).join(", ")}`);
  console.log(`  hybrid search        ${after.hybrid_search_enabled}`);
  console.log(`  reranking            ${after.reranking}`);
  console.log(`  engine cache         ${after.cache}`);
  console.log(`  public endpoint      ${after.public_endpoint_id ?? "disabled"}`);
  console.log(`  paused               ${after.paused}`);
  console.log(`  status               ${after.status}`);

  const problems = [];
  if (after.cache !== false) problems.push("engine-side cache is enabled; its key does not include the per-agent ACL filter");
  if (after.public_endpoint_id) problems.push("a public endpoint is configured; the index must never be reachable unauthenticated");
  if (problems.length > 0) {
    console.error("\nRefusing to report success:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
