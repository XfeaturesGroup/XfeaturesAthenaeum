import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticateRpcCredential } from "../../src/auth/authenticate";
import { AgentsRepository } from "../../src/repositories/agents.repository";
import { AuditRepository } from "../../src/repositories/audit.repository";
import type { Env } from "../../src/env";
import { createAgent, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";
// Source inlined at build time: workerd has no filesystem.
import ADMIN_AGENTS_SRC from "../../src/api/routes/admin/agents.ts?raw";

const testEnv = env as unknown as Env;

let repo: AgentsRepository;
let audit: AuditRepository;

/**
 * Removing a principal from Access (migration 0007).
 *
 * The operator-facing problem is small -- a mistyped agent sits in the console
 * forever once it is revoked -- and the implementation is not, because three
 * foreign keys point at `agents` with no cascade and every one of them records
 * something worth keeping: who Athenaeum decided a caller was, who reported a
 * fact was wrong, who asked for a value to change.
 *
 * So what is pinned here is the split. A principal that left no trace is
 * destroyed. One that did becomes a tombstone that cannot authenticate, cannot
 * be re-linked to an Account identity, and cannot be brought back -- while the
 * records naming it still point at something.
 */
beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  repo = new AgentsRepository(testEnv.DB);
  audit = new AuditRepository(testEnv.DB);
});

let admin: SeededAgent;
let target: SeededAgent;

beforeEach(async () => {
  admin = await createAgent(testEnv, `deleting-admin-${crypto.randomUUID()}`, "knowledge-admin");
  target = await createAgent(testEnv, `doomed-${crypto.randomUUID()}`, "support-agent");
});

/** The route's own rule, exercised through the repository the route calls. */
async function deleteAgent(agentId: string, deletedBy: string): Promise<"purged" | "tombstoned"> {
  const references = await repo.countReferences(agentId);
  if (references === 0) {
    const purged = await repo.purge(agentId);
    if (!purged) throw new Error("purge refused");
    return "purged";
  }
  const tombstone = await repo.softDelete(agentId, deletedBy);
  if (!tombstone) throw new Error("soft delete refused");
  return "tombstoned";
}

describe("deletion is refused until the credential has already been stopped", () => {
  it("will not purge an active principal", async () => {
    expect(await repo.purge(target.agentId)).toBe(false);
    expect(await repo.findById(target.agentId)).not.toBeNull();
  });

  it("will not tombstone an active principal", async () => {
    expect(await repo.softDelete(target.agentId, admin.agentId)).toBeNull();
  });

  it("will not tombstone a merely disabled principal", async () => {
    await repo.setStatus(target.agentId, "disabled", admin.agentId);

    expect(await repo.softDelete(target.agentId, admin.agentId)).toBeNull();
    expect(await repo.purge(target.agentId)).toBe(false);
  });
});

describe("a principal that left no trace is destroyed outright", () => {
  it("removes the row and its role grants", async () => {
    await repo.setStatus(target.agentId, "revoked", admin.agentId);

    expect(await deleteAgent(target.agentId, admin.agentId)).toBe("purged");
    expect(await repo.findById(target.agentId)).toBeNull();

    const roles = await testEnv.DB.prepare("SELECT COUNT(*) AS held FROM agent_roles WHERE agent_id = ?1")
      .bind(target.agentId)
      .first<{ held: number }>();
    expect(roles?.held).toBe(0);
  });
});

describe("a principal with history becomes a tombstone, and its history survives", () => {
  beforeEach(async () => {
    await audit.record({
      requestId: `req-${crypto.randomUUID()}`,
      actorAgentId: target.agentId,
      action: "knowledge.search",
      decision: "ALLOW"
    });
    await repo.setStatus(target.agentId, "revoked", admin.agentId);
  });

  it("keeps the audit event pointing at it", async () => {
    expect(await deleteAgent(target.agentId, admin.agentId)).toBe("tombstoned");

    const events = await audit.list({ actorAgentId: target.agentId, limit: 10, offset: 0 });
    expect(events).toHaveLength(1);
    // The trail outliving the identity is the entire point of a trail. The key
    // stays on the row so the event is still readable.
    expect(events[0]?.actor_agent_key).toBe(target.agentKey);
  });

  it("disappears from every lookup the rest of the service uses", async () => {
    await deleteAgent(target.agentId, admin.agentId);

    expect(await repo.findById(target.agentId)).toBeNull();
    expect(await repo.findByAgentKey(target.agentKey)).toBeNull();
    expect(await repo.resolvePermissions(target.agentId)).toEqual(new Set());
  });

  it("disappears from the Access listing, but can still be looked up deliberately", async () => {
    await deleteAgent(target.agentId, admin.agentId);

    const listed = await repo.list({ limit: 100, offset: 0 });
    expect(listed.map((agent) => agent.id)).not.toContain(target.agentId);

    // An operator asking what happened to a principal an audit event names.
    const withDeleted = await repo.list({ limit: 100, offset: 0, includeDeleted: true });
    expect(withDeleted.map((agent) => agent.id)).toContain(target.agentId);
  });

  it("cannot authenticate afterwards, with the credential it used to hold", async () => {
    // Revoked is already enough to stop the credential -- that is the point of
    // revoking, and it happens before any deletion is allowed.
    const before = await authenticateRpcCredential({ agentKey: target.agentKey, rpcKey: target.rpcKey }, testEnv);
    expect(before.ok).toBe(false);

    await deleteAgent(target.agentId, admin.agentId);

    const after = await authenticateRpcCredential({ agentKey: target.agentKey, rpcKey: target.rpcKey }, testEnv);
    expect(after.ok).toBe(false);
    // Not "disabled" any more: there is no principal there to disable.
    if (!after.ok) expect(after.reason).toBe("UNKNOWN_AGENT");
  });

  it("keeps no credential material at all", async () => {
    await deleteAgent(target.agentId, admin.agentId);

    const row = await testEnv.DB.prepare("SELECT * FROM agents WHERE id = ?1")
      .bind(target.agentId)
      .first<{ rpc_key_hash: string | null; account_client_id: string | null; account_user_id: string | null; deleted_at: string | null }>();

    // Nothing left to authenticate with, and nothing left to re-link to an
    // Account identity: a tombstone cannot become a working credential again.
    expect(row?.rpc_key_hash).toBeNull();
    expect(row?.account_client_id).toBeNull();
    expect(row?.account_user_id).toBeNull();
    expect(row?.deleted_at).not.toBeNull();
  });

  it("cannot be brought back by setting a status on it", async () => {
    await deleteAgent(target.agentId, admin.agentId);

    await repo.setStatus(target.agentId, "active", admin.agentId);

    const row = await testEnv.DB.prepare("SELECT status FROM agents WHERE id = ?1")
      .bind(target.agentId)
      .first<{ status: string }>();
    expect(row?.status).toBe("revoked");
    expect(await repo.findById(target.agentId)).toBeNull();
  });

  it("cannot be deleted twice", async () => {
    await deleteAgent(target.agentId, admin.agentId);

    expect(await repo.softDelete(target.agentId, admin.agentId)).toBeNull();
    expect(await repo.purge(target.agentId)).toBe(false);
  });
});

describe("counting what would be orphaned", () => {
  it("sees an audit event", async () => {
    await audit.record({
      requestId: `req-${crypto.randomUUID()}`,
      actorAgentId: target.agentId,
      action: "knowledge.search",
      decision: "ALLOW"
    });
    expect(await repo.countReferences(target.agentId)).toBe(1);
  });

  it("sees a fact proposal, whether it proposed or reviewed it", async () => {
    await testEnv.DB.prepare(
      `INSERT INTO fact_proposals (id, namespace, key, value_json, classification, status, proposed_by, created_at)
       VALUES (?1, 'products', 'k', '{}', 'PUBLIC', 'pending', ?2, '2026-01-01T00:00:00.000Z')`
    )
      .bind(crypto.randomUUID(), target.agentId)
      .run();

    expect(await repo.countReferences(target.agentId)).toBe(1);
  });

  it("sees knowledge feedback", async () => {
    await testEnv.DB.prepare(
      `INSERT INTO knowledge_feedback (id, source_type, source_id, feedback_type, submitted_by_agent_id, created_at)
       VALUES (?1, 'document', 'doc-1', 'incorrect', ?2, '2026-01-01T00:00:00.000Z')`
    )
      .bind(crypto.randomUUID(), target.agentId)
      .run();

    expect(await repo.countReferences(target.agentId)).toBe(1);
  });

  it("reports nothing for a principal that never did anything", async () => {
    expect(await repo.countReferences(target.agentId)).toBe(0);
  });
});

/**
 * Two of the rules live in the route rather than in SQL, because they are about
 * who is asking rather than about the row. A structural tripwire, in the style
 * of the quota and transport-parity checks: a behavioural test cannot reach
 * them (no Access JWT is mintable in tests), and quietly losing either one
 * would be worse than not having written them.
 */
describe("the route's own rules", () => {
  const handler = ADMIN_AGENTS_SRC.split("export async function handleDeleteAgent", 2)[1] ?? "";

  it("exists", () => {
    expect(handler.length).toBeGreaterThan(0);
  });

  it("refuses to delete the principal doing the deleting", () => {
    // HQ operates as one machine principal, so without this an operator could
    // cut the whole console off from Athenaeum with a single authorized click.
    expect(handler).toContain("agent.id === principal.agentId");
  });

  it("refuses anything that has not already been revoked", () => {
    expect(handler).toContain('agent.status !== "revoked"');
  });

  it("records what was removed before removing it", () => {
    expect(handler).toContain('action: "admin.agents.delete"');
    expect(handler).toContain("agent_key: agent.agent_key");
    expect(handler).toContain("roles");
  });
});
