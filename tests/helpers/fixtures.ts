import { AgentsRepository } from "../../src/repositories/agents.repository";
import { RolesRepository } from "../../src/repositories/roles.repository";
import { FactsRepository } from "../../src/repositories/facts.repository";
import { DocumentsRepository } from "../../src/repositories/documents.repository";
import type { Env } from "../../src/env";
import type { Principal } from "../../src/auth/types";
import type { Classification } from "../../src/security/classification";
import { hashRpcKey } from "../../src/utils/hash";
import { applySchema } from "./db";

/** Permission taxonomy mirroring seed/dev-seed.sql, kept minimal for tests. */
const PERMISSIONS = [
  "knowledge.search",
  "knowledge.classification.PUBLIC",
  "knowledge.classification.INTERNAL",
  "knowledge.classification.CONFIDENTIAL",
  "knowledge.classification.RESTRICTED",
  "documents.read.public",
  "documents.read.support",
  "documents.read.network",
  "documents.write",
  "documents.publish",
  "facts.read.products",
  "facts.read.plans",
  "facts.read.policies",
  "facts.read.secrets",
  "facts.write",
  "products.read",
  "prices.read",
  "network.read",
  "feedback.submit",
  "audit.read",
  "admin.agents",
  "admin.facts",
  "admin.documents",
  "admin.ingestion"
] as const;

export const ROLE_FIXTURES = {
  // Weakest identity in the system: a public chatbot.
  "public-agent": ["knowledge.search", "knowledge.classification.PUBLIC", "documents.read.public", "facts.read.products", "products.read"],
  "support-agent": [
    "knowledge.search",
    "knowledge.classification.PUBLIC",
    "knowledge.classification.INTERNAL",
    "documents.read.public",
    "documents.read.support",
    "facts.read.products",
    "facts.read.plans",
    "products.read",
    "prices.read"
  ],
  // Holds administrative fact rights but NOT high classifications -- the
  // exact shape that made SR-002/SR-003 exploitable.
  "limited-fact-admin": ["admin.facts", "knowledge.classification.PUBLIC", "facts.read.products"],
  // Can draft and submit for review, but deliberately lacks documents.publish
  // -- the permission-level half of human-in-the-loop publish.
  "content-contributor": [
    "knowledge.search",
    "knowledge.classification.PUBLIC",
    "knowledge.classification.INTERNAL",
    "documents.read.public",
    "documents.write",
    "admin.documents"
  ],
  "knowledge-admin": [...PERMISSIONS]
} satisfies Record<string, string[]>;

export type RoleName = keyof typeof ROLE_FIXTURES;

export interface SeededAgent {
  agentId: string;
  agentKey: string;
  rpcKey: string;
  principal: Principal;
}

/** Applies the real schema and seeds the permission/role graph exactly as production would. */
export async function seedSecurityFixtures(env: Env): Promise<void> {
  await applySchema(env.DB);

  const rolesRepo = new RolesRepository(env.DB);
  for (const key of PERMISSIONS) {
    await env.DB.prepare("INSERT OR IGNORE INTO permissions (id, key, description) VALUES (?1, ?2, ?3)")
      .bind(`perm_${key.replace(/[.*]/g, "_")}`, key, key)
      .run();
  }

  for (const [roleName, permissionKeys] of Object.entries(ROLE_FIXTURES)) {
    const role = await rolesRepo.create(roleName, `${roleName} fixture`);
    for (const permissionKey of permissionKeys) {
      const permission = await rolesRepo.getPermissionByKey(permissionKey);
      if (permission) await rolesRepo.grantPermission(role.id, permission.id);
    }
  }
}

/** Creates an active agent bound to a role and returns a usable RPC credential + resolved Principal. */
export async function createAgent(env: Env, agentKey: string, roleName: RoleName): Promise<SeededAgent> {
  const agentsRepo = new AgentsRepository(env.DB);
  const rolesRepo = new RolesRepository(env.DB);

  const rpcKey = `test-key-${agentKey}`;
  const agent = await agentsRepo.create({
    agentKey,
    name: agentKey,
    environment: env.ENVIRONMENT,
    authMode: "rpc",
    rpcKeyHash: await hashRpcKey(rpcKey, env.RPC_KEY_PEPPER),
    createdBy: "test-fixture"
  });

  const role = await rolesRepo.getByName(roleName);
  if (!role) throw new Error(`Missing role fixture: ${roleName}`);
  await agentsRepo.assignRole(agent.id, role.id);

  const permissions = await agentsRepo.resolvePermissions(agent.id);
  return {
    agentId: agent.id,
    agentKey,
    rpcKey,
    principal: { agentId: agent.id, agentKey, environment: env.ENVIRONMENT, permissions }
  };
}

export async function createFact(
  env: Env,
  namespace: string,
  key: string,
  classification: Classification,
  value: unknown = { secret: true }
): Promise<void> {
  await new FactsRepository(env.DB).create({
    namespace,
    key,
    valueJson: JSON.stringify(value),
    classification,
    createdBy: "test-fixture"
  });
}

export async function createDocument(
  env: Env,
  slug: string,
  domain: string,
  classification: Classification,
  status: "draft" | "active" | "archived" = "active"
): Promise<string> {
  const repo = new DocumentsRepository(env.DB);
  const doc = await repo.create({
    slug,
    title: `${slug} title`,
    r2Key: `knowledge/${classification.toLowerCase()}/${domain}/${slug}/v1.bin`,
    domain,
    classification,
    language: "en",
    contentHash: `hash-${slug}`,
    createdBy: "test-fixture"
  });
  if (status !== "draft") await repo.setStatus(doc.id, status, "test-fixture");
  return doc.id;
}
