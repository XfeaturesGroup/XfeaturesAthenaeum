import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { QuotaRepository } from "../../src/repositories/quota.repository";
import { enforceQuota } from "../../src/security/quota";
import { ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import { createAgent, seedSecurityFixtures } from "../helpers/fixtures";
// Source is inlined at build time: tests run inside workerd, which has no filesystem.
import ADMIN_DOCUMENTS_SOURCE from "../../src/api/routes/admin/documents.ts?raw";
import ADMIN_INGESTION_SOURCE from "../../src/api/routes/admin/ingestion.ts?raw";
import ADMIN_FACTS_SOURCE from "../../src/api/routes/admin/facts.ts?raw";

const testEnv = env as unknown as Env;

beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
});

describe("QuotaRepository against a real D1 instance", () => {
  it("recordUsage atomically increments and returns the new count via a single UPSERT+RETURNING", async () => {
    const repo = new QuotaRepository(testEnv.DB);
    const agent = await createAgent(testEnv, "quota-repo-agent-1", "public-agent");

    const first = await repo.recordUsage(agent.agentId, "searches");
    const second = await repo.recordUsage(agent.agentId, "searches");
    const third = await repo.recordUsage(agent.agentId, "searches");

    expect([first, second, third]).toEqual([1, 2, 3]);
  });

  it("tracks searches, writes and uploads independently for the same agent/day", async () => {
    const repo = new QuotaRepository(testEnv.DB);
    const agent = await createAgent(testEnv, "quota-repo-agent-2", "public-agent");

    await repo.recordUsage(agent.agentId, "searches");
    await repo.recordUsage(agent.agentId, "searches");
    const writes = await repo.recordUsage(agent.agentId, "writes");
    const uploads = await repo.recordUsage(agent.agentId, "uploads");

    expect(writes).toBe(1);
    expect(uploads).toBe(1);
  });

  it("getQuota returns null for an agent with no quota row (unlimited by default)", async () => {
    const repo = new QuotaRepository(testEnv.DB);
    const agent = await createAgent(testEnv, "quota-repo-agent-3", "public-agent");
    expect(await repo.getQuota(agent.agentId)).toBeNull();
  });

  it("setQuota upserts, and a second call overwrites rather than duplicating", async () => {
    const repo = new QuotaRepository(testEnv.DB);
    const agent = await createAgent(testEnv, "quota-repo-agent-4", "public-agent");

    await repo.setQuota(agent.agentId, { maxSearchesPerDay: 10 }, "test");
    await repo.setQuota(agent.agentId, { maxSearchesPerDay: 5, maxWritesPerDay: 20 }, "test");

    const quota = await repo.getQuota(agent.agentId);
    expect(quota?.max_searches_per_day).toBe(5);
    expect(quota?.max_writes_per_day).toBe(20);
    expect(quota?.max_uploads_per_day).toBeNull();
  });
});

describe("enforceQuota", () => {
  it("never throws for an agent with no quota row, no matter how many calls", async () => {
    const agent = await createAgent(testEnv, "quota-enforce-agent-1", "public-agent");
    for (let i = 0; i < 5; i++) {
      await expect(enforceQuota(testEnv, agent.principal, "searches")).resolves.toBeUndefined();
    }
  });

  it("allows exactly up to the daily max, then rejects with QUOTA_EXCEEDED", async () => {
    const agent = await createAgent(testEnv, "quota-enforce-agent-2", "public-agent");
    await new QuotaRepository(testEnv.DB).setQuota(agent.agentId, { maxSearchesPerDay: 2 }, "test");

    await expect(enforceQuota(testEnv, agent.principal, "searches")).resolves.toBeUndefined();
    await expect(enforceQuota(testEnv, agent.principal, "searches")).resolves.toBeUndefined();
    await expect(enforceQuota(testEnv, agent.principal, "searches")).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED });
  });

  it("a cap on one kind does not block a different kind for the same agent", async () => {
    const agent = await createAgent(testEnv, "quota-enforce-agent-3", "public-agent");
    await new QuotaRepository(testEnv.DB).setQuota(agent.agentId, { maxSearchesPerDay: 1 }, "test");

    await enforceQuota(testEnv, agent.principal, "searches");
    await expect(enforceQuota(testEnv, agent.principal, "searches")).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED });

    // writes has no cap set on this agent -- unaffected by the exhausted searches cap.
    await expect(enforceQuota(testEnv, agent.principal, "writes")).resolves.toBeUndefined();
  });

  it("a cap on one agent does not affect another agent's usage of the same kind", async () => {
    const agentA = await createAgent(testEnv, "quota-enforce-agent-4a", "public-agent");
    const agentB = await createAgent(testEnv, "quota-enforce-agent-4b", "public-agent");
    await new QuotaRepository(testEnv.DB).setQuota(agentA.agentId, { maxSearchesPerDay: 1 }, "test");

    await enforceQuota(testEnv, agentA.principal, "searches");
    await expect(enforceQuota(testEnv, agentA.principal, "searches")).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED });

    // agentB has no quota row at all -- its own usage is unaffected by agentA's cap.
    await expect(enforceQuota(testEnv, agentB.principal, "searches")).resolves.toBeUndefined();
  });
});

/**
 * SR-022: a daily quota is only a ceiling if it cannot be stepped around by
 * picking a different verb. Quota started out on some mutating routes and not
 * others -- publish, review-decision, rollback and BOTH reindex paths were
 * uncapped, including the one whose own comment calls it "the most expensive
 * operation in the system". An agent at its write limit could simply keep
 * publishing, or trigger a full reindex, indefinitely.
 *
 * This is a source-inspection tripwire rather than a behavioural test because
 * the property is structural: every mutating admin handler must consume quota.
 * A behavioural test would only cover the handlers someone remembered to
 * write a case for -- which is exactly how the gap appeared.
 */
describe("SR-022: every mutating admin route consumes daily quota", () => {
  /** Handlers that mutate state or trigger real cost. Read-only handlers are excluded by name. */
  const READ_ONLY = new Set([
    "handleListDocuments",
    "handleGetDocumentForAdmin",
    // Reads a document's version history. No writes, no storage cost beyond a
    // single indexed D1 query, and rate-limited like any other read.
    "handleListDocumentVersions",
    "handleListIngestionJobs",
    "handleListAuditEvents",
    "handleListAgents",
    "handleGetAgent",
    "handleListRoles"
  ]);

  const SOURCES: Record<string, string> = {
    "admin/documents.ts": ADMIN_DOCUMENTS_SOURCE,
    "admin/ingestion.ts": ADMIN_INGESTION_SOURCE,
    "admin/facts.ts": ADMIN_FACTS_SOURCE
  };

  for (const [name, source] of Object.entries(SOURCES)) {
    // Split the module into per-handler bodies so each can be checked alone.
    const bodies = source.split(/^export async function /gm).slice(1);

    for (const body of bodies) {
      const handler = body.slice(0, body.indexOf("(")).trim();
      if (READ_ONLY.has(handler)) continue;

      it(`${name}: ${handler} consumes quota`, () => {
        expect(body, `${handler} mutates state but never calls enforceQuota`).toContain("enforceQuota(");
      });
    }
  }
});
