import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
// Source inlined at build time: workerd has no filesystem.
import ADMIN_AUDIT_SRC from "../../src/api/routes/admin/audit.ts?raw";
import ADMIN_INGESTION_SRC from "../../src/api/routes/admin/ingestion.ts?raw";
import { OperationsService } from "../../src/knowledge/operations";
import { AuditRepository } from "../../src/repositories/audit.repository";
import { IngestionRepository } from "../../src/repositories/ingestion.repository";
import type { Env } from "../../src/env";
import { createAgent, createDocument, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

let admin: SeededAgent;
let documentId: string;
let operations: OperationsService;

/** `rows[0]` is `T | undefined` under strict indexing; a missing row is a failed test, not a type to handle. */
function first<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error("Expected at least one row.");
  return row;
}

/**
 * The two administrative read surfaces the console is built on.
 *
 * Both used to answer with the raw D1 row, which is how the console ended up
 * showing "Invalid Date" and an em dash in every column: the row says
 * `document_id` and `occurred_at`, every other endpoint in this API says
 * `documentId` and `occurredAt`, and nothing reconciled the two. These tests
 * pin the console-facing shape so the next reader cannot quietly go back to
 * returning the row.
 *
 * The audit case is not only cosmetic. `actor_identity_raw` is the
 * unprocessed identity string the caller presented, kept for forensics; it has
 * no business in a listing response, and the raw row shipped it to every
 * reader of the audit trail.
 */
beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  admin = await createAgent(testEnv, "console-admin", "knowledge-admin");
  documentId = await createDocument(testEnv, "console-doc", "support", "INTERNAL");
  operations = new OperationsService(new IngestionRepository(testEnv.DB), new AuditRepository(testEnv.DB));
});

describe("the ingestion view answers in the console's shape", () => {
  it("names every field the way the rest of the API names it", async () => {
    await new IngestionRepository(testEnv.DB).create(documentId, "index");

    const job = first(await operations.listIngestionJobs({}, 20, 0));

    expect(Object.keys(job).sort()).toEqual(
      [
        "attempts",
        "createdAt",
        "documentId",
        "documentSlug",
        "documentStatus",
        "documentTitle",
        "id",
        "jobType",
        "lastErrorCode",
        "status",
        "updatedAt"
      ].sort()
    );
    expect(job.documentId).toBe(documentId);
    expect(job.jobType).toBe("index");
    expect(job.attempts).toBe(0);
    expect(Number.isNaN(Date.parse(job.updatedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(job.createdAt))).toBe(false);
  });

  it("carries the document's title so a row is recognisable without an id lookup", async () => {
    const job = first(await operations.listIngestionJobs({}, 20, 0));

    expect(job.documentTitle).toBe("console-doc title");
    expect(job.documentSlug).toBe("console-doc");
    expect(job.documentStatus).toBe("active");
  });

  it("still lists a job whose document is gone, rather than dropping it", async () => {
    // A job outlives the document it indexed: the trash purge removes the
    // document row, and an inner join would silently erase the evidence that
    // anything was ever indexed for it.
    await testEnv.DB.prepare(
      `INSERT INTO ingestion_jobs (id, document_id, job_type, status, attempt_count, created_at, updated_at)
       VALUES ('job-orphan', NULL, 'delete', 'completed', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run();

    const jobs = await operations.listIngestionJobs({}, 50, 0);
    const orphan = jobs.find((job) => job.id === "job-orphan");

    expect(orphan).toBeDefined();
    expect(orphan?.documentId).toBeNull();
    expect(orphan?.documentTitle).toBeNull();
  });

  it("narrows to one status when asked", async () => {
    const completed = await operations.listIngestionJobs({ status: "completed" }, 50, 0);

    expect(completed.length).toBeGreaterThan(0);
    expect(completed.every((job) => job.status === "completed")).toBe(true);
  });
});

describe("the audit view answers in the console's shape", () => {
  beforeAll(async () => {
    const auditRepo = new AuditRepository(testEnv.DB);
    await auditRepo.record({
      requestId: "req-allow",
      actorAgentId: admin.agentId,
      actorIdentityRaw: "raw-identity-do-not-disclose",
      action: "admin.documents.list",
      decision: "ALLOW",
      resourceType: "document",
      resourceId: documentId,
      newValue: { status: "active" }
    });
    await auditRepo.record({
      requestId: "req-deny",
      actorAgentId: admin.agentId,
      action: "facts.read",
      decision: "DENY",
      reason: "MISSING_CLASSIFICATION_PERMISSION",
      resourceType: "fact",
      resourceId: "secrets/master-key"
    });
    await auditRepo.record({
      requestId: "req-na",
      actorAgentId: null,
      action: "mcp.connect",
      decision: "N/A",
      reason: "TOKEN_EXPIRED"
    });
  });

  it("names every field the way the rest of the API names it", async () => {
    const event = first(await operations.listAuditEvents({ limit: 1, offset: 0 }));

    expect(Object.keys(event).sort()).toEqual(
      [
        "action",
        "actorAgentId",
        "actorAgentKey",
        "decision",
        "id",
        "newValue",
        "occurredAt",
        "oldValue",
        "reason",
        "requestId",
        "resourceId",
        "resourceType",
        "status"
      ].sort()
    );
    expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
  });

  it("resolves the principal to the key an operator recognises", async () => {
    const events = await operations.listAuditEvents({ limit: 50, offset: 0 });
    const allowed = events.find((event) => event.requestId === "req-allow");

    expect(allowed?.actorAgentId).toBe(admin.agentId);
    expect(allowed?.actorAgentKey).toBe("console-admin");
  });

  it("keeps the three decisions distinct, so a refusal cannot read as a grant", async () => {
    const events = await operations.listAuditEvents({ limit: 50, offset: 0 });

    expect(events.find((event) => event.requestId === "req-allow")?.decision).toBe("ALLOW");
    expect(events.find((event) => event.requestId === "req-deny")?.decision).toBe("DENY");
    // Not a decision at all: nothing was authorized, and reporting it as a
    // grant is how an unauthenticated attempt came to look like an allowed one.
    expect(events.find((event) => event.requestId === "req-na")?.decision).toBe("N/A");
  });

  it("returns the recorded before/after values already parsed", async () => {
    const events = await operations.listAuditEvents({ limit: 50, offset: 0 });
    const allowed = events.find((event) => event.requestId === "req-allow");

    expect(allowed?.newValue).toEqual({ status: "active" });
    expect(allowed?.oldValue).toBeNull();
  });

  it("never discloses the raw identity the caller presented", async () => {
    const events = await operations.listAuditEvents({ limit: 50, offset: 0 });

    expect(JSON.stringify(events)).not.toContain("raw-identity-do-not-disclose");
    expect(JSON.stringify(events)).not.toContain("actorIdentityRaw");
    expect(JSON.stringify(events)).not.toContain("actor_identity_raw");
  });

  it("narrows to refusals when asked, without the client having to filter", async () => {
    const denials = await operations.listAuditEvents({ limit: 50, offset: 0, decision: "DENY" });

    expect(denials.length).toBeGreaterThan(0);
    expect(denials.every((event) => event.decision === "DENY")).toBe(true);
  });

  it("narrows to one action and one principal", async () => {
    const byAction = await operations.listAuditEvents({ limit: 50, offset: 0, action: "facts.read" });
    expect(byAction.every((event) => event.action === "facts.read")).toBe(true);

    const byActor = await operations.listAuditEvents({ limit: 50, offset: 0, actorAgentId: admin.agentId });
    expect(byActor.length).toBeGreaterThan(0);
    expect(byActor.every((event) => event.actorAgentId === admin.agentId)).toBe(true);
  });
});

/**
 * The mapping only protects anything if the routes actually go through it.
 * Returning `repo.list(...)` straight out of a handler is exactly how both of
 * these endpoints came to answer with the database row.
 */
describe("no administrative route answers with a raw database row", () => {
  const routes = [
    { name: "ingestion", source: ADMIN_INGESTION_SRC, forbidden: "ingestionRepo.list" },
    { name: "audit", source: ADMIN_AUDIT_SRC, forbidden: "auditRepo.list" }
  ];

  for (const route of routes) {
    it(`${route.name} projects through the operations service`, () => {
      expect(route.source).toContain("services.operations.");
      expect(route.source).not.toContain(route.forbidden);
    });
  }
});
