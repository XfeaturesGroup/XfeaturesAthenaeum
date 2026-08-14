import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticateRpcCredential } from "../../src/auth/authenticate";
import { AgentsRepository } from "../../src/repositories/agents.repository";
import { RolesRepository } from "../../src/repositories/roles.repository";
import { hashRpcKey } from "../../src/utils/hash";
import type { Env } from "../../src/env";
import { applySchema } from "../helpers/db";

const testEnv = env as unknown as Env;
const RPC_KEY = "test-rpc-key-0123456789";

beforeAll(async () => {
  await applySchema(testEnv.DB);

  const rolesRepo = new RolesRepository(testEnv.DB);
  const role = await rolesRepo.create("test-role", "role for authentication tests");
  const permission = await testEnv.DB.prepare(
    "INSERT INTO permissions (id, key, description) VALUES ('perm_test_search', 'knowledge.search', 'test') RETURNING *"
  ).first<{ id: string }>();
  if (permission) {
    await rolesRepo.grantPermission(role.id, permission.id);
  }

  const agentsRepo = new AgentsRepository(testEnv.DB);
  const rpcKeyHash = await hashRpcKey(RPC_KEY, testEnv.RPC_KEY_PEPPER);
  const activeAgent = await agentsRepo.create({
    agentKey: "active-rpc-agent",
    name: "Active RPC Agent",
    environment: "development",
    authMode: "rpc",
    rpcKeyHash,
    createdBy: "test-setup"
  });
  await agentsRepo.assignRole(activeAgent.id, role.id);

  const disabledAgent = await agentsRepo.create({
    agentKey: "disabled-rpc-agent",
    name: "Disabled RPC Agent",
    environment: "development",
    authMode: "rpc",
    rpcKeyHash,
    createdBy: "test-setup"
  });
  await agentsRepo.setStatus(disabledAgent.id, "disabled", "test-setup");
});

// "unknown identity -> anything -> DENY", "disabled agent -> anything -> DENY".
describe("authenticateRpcCredential: fail-closed identity resolution", () => {
  it("denies a completely unknown agent key", async () => {
    const result = await authenticateRpcCredential({ agentKey: "does-not-exist", rpcKey: RPC_KEY }, testEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNKNOWN_AGENT");
  });

  it("denies a disabled agent even with the correct key", async () => {
    const result = await authenticateRpcCredential({ agentKey: "disabled-rpc-agent", rpcKey: RPC_KEY }, testEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("AGENT_DISABLED");
  });

  it("denies an active agent with the wrong key", async () => {
    const result = await authenticateRpcCredential({ agentKey: "active-rpc-agent", rpcKey: "wrong-key" }, testEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_TOKEN");
  });

  it("denies malformed credentials (missing fields)", async () => {
    const result = await authenticateRpcCredential({ agentKey: "active-rpc-agent" }, testEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MISSING_CREDENTIALS");
  });

  it("resolves a Principal with the agent's actual granted permissions for a valid active agent", async () => {
    const result = await authenticateRpcCredential({ agentKey: "active-rpc-agent", rpcKey: RPC_KEY }, testEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.agentKey).toBe("active-rpc-agent");
      expect(result.principal.permissions.has("knowledge.search")).toBe(true);
      // Never grants anything beyond what was actually assigned.
      expect(result.principal.permissions.has("admin.agents")).toBe(false);
    }
  });
});
