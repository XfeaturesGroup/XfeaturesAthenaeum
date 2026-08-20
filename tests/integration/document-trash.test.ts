import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentsService } from "../../src/knowledge/documents";
import { DocumentsRepository } from "../../src/repositories/documents.repository";
import { IngestionRepository } from "../../src/repositories/ingestion.repository";
import { R2DocumentStorage } from "../../src/storage/r2";
import { SearchService } from "../../src/knowledge/search";
import { purgeExpiredTrash } from "../../src/maintenance/purge-trash";
import { LIMITS } from "../../src/config";
import { ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import type { RetrievalChunk, RetrievalQuery, KnowledgeSearchProvider } from "../../src/search/types";
import { createAgent, seedSecurityFixtures } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

function textContent(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function buildService(): DocumentsService {
  return new DocumentsService(
    new DocumentsRepository(testEnv.DB),
    new IngestionRepository(testEnv.DB),
    new R2DocumentStorage(testEnv.DOCS),
    testEnv
  );
}

/** Feeds retrieval whatever the engine is pretending to have returned. */
class StagedProvider implements KnowledgeSearchProvider {
  staged: RetrievalChunk[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async search(query: RetrievalQuery): Promise<RetrievalChunk[]> {
    void query; // the staged response is fixed; the query is irrelevant here
    return this.staged;
  }
}

const HOUR = 3600_000;

beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
});

async function publishedDocument(slug: string, agentKey: string) {
  const admin = await createAgent(testEnv, agentKey, "knowledge-admin");
  const service = buildService();
  const repo = new DocumentsRepository(testEnv.DB);
  const draft = await service.createDraft(
    admin.principal,
    {
      slug,
      title: "Trash subject",
      domain: "public",
      classification: "PUBLIC",
      language: "en",
      content: textContent("body of " + slug),
      contentType: "text/markdown"
    },
    admin.principal.agentId
  );
  await repo.setStatus(draft.id, "active", admin.principal.agentId);
  return { admin, service, repo, id: draft.id };
}

/** Backdates a trashed document so the retention window has closed. */
async function backdateTrash(documentId: string, hoursAgo: number): Promise<void> {
  const when = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  await testEnv.DB.prepare("UPDATE documents SET trashed_at = ?1 WHERE id = ?2").bind(when, documentId).run();
}

describe("moving a document to the trash", () => {
  it("records when it happened and what to restore to", async () => {
    const { admin, service, repo, id } = await publishedDocument("trash-doc-1", "trash-admin-1");

    const trashed = await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    expect(trashed.status).toBe("trashed");

    const row = await repo.getById(id);
    expect(row?.trashed_at).toBeTruthy();
    expect(row?.status_before_trash).toBe("active");
  });

  it("is immediately invisible to every read path", async () => {
    const { admin, service, id } = await publishedDocument("trash-doc-2", "trash-admin-2");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);

    // The public read paths resolve only active documents.
    await expect(service.getDocumentMetadata(admin.principal, id)).rejects.toMatchObject({ publicCode: ErrorCode.NOT_FOUND });
    await expect(service.getDocumentContent(admin.principal, id)).rejects.toMatchObject({ publicCode: ErrorCode.NOT_FOUND });
  });

  it("does not appear in an ordinary document listing", async () => {
    const { admin, service, id } = await publishedDocument("trash-doc-3", "trash-admin-3");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);

    const listed = await service.listDocuments(admin.principal, { limit: 100, offset: 0 });
    expect(listed.map((d) => d.id)).not.toContain(id);
  });

  it("appears in the trash with the time it has left", async () => {
    const { admin, service, id } = await publishedDocument("trash-doc-4", "trash-admin-4");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);

    const trash = await service.listTrash(admin.principal, { limit: 50, offset: 0 });
    const entry = trash.find((d) => d.id === id);
    expect(entry).toBeDefined();
    expect(entry?.statusBeforeTrash).toBe("active");
    // Just trashed: essentially the whole window remains.
    expect(entry?.minutesRemaining).toBeGreaterThan(LIMITS.TRASH_RETENTION_HOURS * 60 - 5);
    expect(entry?.minutesRemaining).toBeLessThanOrEqual(LIMITS.TRASH_RETENTION_HOURS * 60);
  });

  it("queues an index removal for a published document", async () => {
    const { admin, service, id } = await publishedDocument("trash-doc-5", "trash-admin-5");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);

    const row = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM ingestion_jobs WHERE document_id = ?1 AND job_type = 'delete'"
    ).bind(id).first<{ n: number }>();
    expect(row?.n).toBeGreaterThanOrEqual(1);
  });

  it("refuses to trash the same document twice", async () => {
    const { admin, service, id } = await publishedDocument("trash-doc-6", "trash-admin-6");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await expect(service.moveToTrash(admin.principal, id, admin.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT
    });
  });

  it("requires documents.publish, not merely documents.write", async () => {
    const { service, id } = await publishedDocument("trash-doc-7", "trash-admin-7");
    // A content-contributor may draft and revise but not publish.
    const contributor = await createAgent(testEnv, "trash-contributor-1", "content-contributor");
    await expect(service.moveToTrash(contributor.principal, id, contributor.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });
});

describe("restoring from the trash", () => {
  it("returns the document to the state it was in", async () => {
    const { admin, service, repo, id } = await publishedDocument("trash-restore-1", "trash-admin-8");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);

    const restored = await service.restoreFromTrash(admin.principal, id, admin.principal.agentId);
    expect(restored.status).toBe("active");

    const row = await repo.getById(id);
    expect(row?.trashed_at).toBeNull();
    expect(row?.status_before_trash).toBeNull();
  });

  it("restores a draft as a draft, never as published", async () => {
    const contributor = await createAgent(testEnv, "trash-contributor-2", "content-contributor");
    const admin = await createAgent(testEnv, "trash-admin-9", "knowledge-admin");
    const service = buildService();
    const draft = await service.createDraft(
      contributor.principal,
      {
        slug: "trash-restore-draft",
        title: "Still a draft",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("draft body"),
        contentType: "text/markdown"
      },
      contributor.principal.agentId
    );

    await service.moveToTrash(admin.principal, draft.id, admin.principal.agentId);
    const restored = await service.restoreFromTrash(admin.principal, draft.id, admin.principal.agentId);
    expect(restored.status).toBe("draft");
  });

  it("restores an archived document as archived, so trash is not a way to revive it", async () => {
    const { admin, service, repo, id } = await publishedDocument("trash-restore-archived", "trash-admin-10");
    await repo.setStatus(id, "archived", admin.principal.agentId);

    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    const restored = await service.restoreFromTrash(admin.principal, id, admin.principal.agentId);
    expect(restored.status).toBe("archived");
  });

  it("refuses to restore something that is not in the trash", async () => {
    const { admin, service, id } = await publishedDocument("trash-restore-2", "trash-admin-11");
    await expect(service.restoreFromTrash(admin.principal, id, admin.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT
    });
  });

  it("requires documents.publish", async () => {
    const { admin, service, id } = await publishedDocument("trash-restore-3", "trash-admin-12");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    const contributor = await createAgent(testEnv, "trash-contributor-3", "content-contributor");
    await expect(service.restoreFromTrash(contributor.principal, id, contributor.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });
});

describe("the trash cannot be used to bypass the lifecycle", () => {
  it("setStatus refuses to touch a document that is in the trash", async () => {
    const { admin, service, repo, id } = await publishedDocument("trash-bypass-1", "trash-admin-13");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);

    // A bare status update would discard the pending deletion, the recorded
    // state to return to, or both.
    await expect(repo.setStatus(id, "active", admin.principal.agentId)).rejects.toThrow(/in the trash/);
  });

  it("the trash cannot be entered by any status update, because it is not a status", async () => {
    // `trashed` is not a member of DocumentStatus at all: it is derived from
    // trashed_at (migration 0003). There is no value a caller could pass to
    // setStatus or transitionStatus that puts a document in the trash without
    // also recording when, and what to restore to.
    const { admin, service, repo, id } = await publishedDocument("trash-bypass-2", "trash-admin-14");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);

    const row = await repo.getById(id);
    expect(row?.trashed_at).toBeTruthy();
    expect(row?.status_before_trash).toBe("active");
    // Reported as trashed even though the stored status is the terminal one.
    expect(row?.status).toBe("archived");
  });

  it("a trashed document cannot be transitioned anywhere, including published", async () => {
    const { admin, service, id } = await publishedDocument("trash-bypass-3", "trash-admin-15");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await expect(service.transitionStatus(admin.principal, id, "active", admin.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT
    });
  });
});

describe("trash is bounded by clearance like everything else", () => {
  it("a principal that cannot read the document does not see it in the trash", async () => {
    const admin = await createAgent(testEnv, "trash-admin-16", "knowledge-admin");
    const service = buildService();
    const repo = new DocumentsRepository(testEnv.DB);
    const draft = await service.createDraft(
      admin.principal,
      {
        slug: "trash-restricted",
        title: "Restricted",
        // `network` + RESTRICTED: the admin fixture holds both, the
        // document-editor holds neither, which is the difference under test.
        domain: "network",
        classification: "RESTRICTED",
        language: "en",
        content: textContent("secret"),
        contentType: "text/markdown"
      },
      admin.principal.agentId
    );
    await repo.setStatus(draft.id, "active", admin.principal.agentId);
    await service.moveToTrash(admin.principal, draft.id, admin.principal.agentId);

    // Holds admin.documents but not the RESTRICTED tier.
    const limited = await createAgent(testEnv, "trash-limited-1", "document-editor");
    const trash = await service.listTrash(limited.principal, { limit: 100, offset: 0 });
    expect(trash.map((d) => d.id)).not.toContain(draft.id);

    // ...and the admin does see it, so the filter is clearance and not emptiness.
    const adminTrash = await service.listTrash(admin.principal, { limit: 100, offset: 0 });
    expect(adminTrash.map((d) => d.id)).toContain(draft.id);
  });
});

describe("retrieval refuses a trashed document even when the engine still offers it", () => {
  it("a stale index hit for a trashed document is dropped", async () => {
    const { admin, service, repo, id } = await publishedDocument("trash-stale-1", "trash-admin-17");
    const row = await repo.getById(id);
    const currentKey = row?.r2_key ?? "";

    // While published, a hit on the current object is served.
    const provider = new StagedProvider();
    const search = new SearchService(provider, new DocumentsRepository(testEnv.DB));
    provider.staged = [
      { sourceId: currentKey, documentId: id, content: "body", classification: "PUBLIC", domain: "public", score: 0.99 }
    ];
    const before = await search.searchKnowledge(admin.principal, { query: "anything" });
    expect(before.results).toHaveLength(1);

    // Trashing it changes nothing about the engine -- the vectors are still
    // there, and this is exactly the case the D1 reconciliation exists for.
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    const after = await search.searchKnowledge(admin.principal, { query: "anything" });
    expect(after.results).toHaveLength(0);
    expect(after.reason).toBe("NO_RELIABLE_MATCH");
  });

  it("a hit for a purged document, whose row is gone entirely, is dropped", async () => {
    const { admin, service, repo, id } = await publishedDocument("trash-stale-2", "trash-admin-18");
    const row = await repo.getById(id);
    const currentKey = row?.r2_key ?? "";

    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await backdateTrash(id, LIMITS.TRASH_RETENTION_HOURS + 1);
    await purgeExpiredTrash(testEnv);

    const provider = new StagedProvider();
    const search = new SearchService(provider, new DocumentsRepository(testEnv.DB));
    provider.staged = [
      { sourceId: currentKey, documentId: id, content: "body", classification: "PUBLIC", domain: "public", score: 0.99 }
    ];
    const result = await search.searchKnowledge(admin.principal, { query: "anything" });
    expect(result.results).toHaveLength(0);
  });
});

describe("the scheduled purge", () => {
  it("leaves a document alone before its window closes", async () => {
    const { admin, service, repo, id } = await publishedDocument("purge-early-1", "purge-admin-1");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await backdateTrash(id, LIMITS.TRASH_RETENTION_HOURS - 1);

    const outcome = await purgeExpiredTrash(testEnv);
    expect(outcome.purged).not.toContain(id);
    expect(await repo.getById(id)).not.toBeNull();
  });

  it("removes the document, its versions and its objects once the window has closed", async () => {
    const { admin, service, repo, id } = await publishedDocument("purge-late-1", "purge-admin-2");
    // Give it a second version so the purge has history to clear.
    await service.createNewVersion(
      admin.principal,
      id,
      { content: textContent("v2"), contentType: "text/markdown", expectedVersion: 1 },
      admin.principal.agentId
    );
    const keys = await repo.allR2Keys(id);
    expect(keys.length).toBeGreaterThanOrEqual(2);

    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await backdateTrash(id, LIMITS.TRASH_RETENTION_HOURS + 1);

    const outcome = await purgeExpiredTrash(testEnv);
    expect(outcome.purged).toContain(id);

    expect(await repo.getById(id)).toBeNull();
    const versions = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?1")
      .bind(id).first<{ n: number }>();
    expect(versions?.n).toBe(0);

    const storage = new R2DocumentStorage(testEnv.DOCS);
    for (const key of keys) {
      expect(await storage.get(key)).toBeNull();
    }
  });

  it("keeps the audit trail after the document is gone", async () => {
    const { admin, service, id } = await publishedDocument("purge-audit-1", "purge-admin-3");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await backdateTrash(id, LIMITS.TRASH_RETENTION_HOURS + 1);
    await purgeExpiredTrash(testEnv);

    const events = await testEnv.DB.prepare(
      "SELECT action, new_value_json, old_value_json FROM audit_events WHERE resource_id = ?1 ORDER BY id"
    ).bind(id).all<{ action: string; new_value_json: string | null; old_value_json: string | null }>();

    expect(events.results.length).toBeGreaterThan(0);
    expect(events.results.some((e) => e.action === "documents.purge")).toBe(true);

    // The trail records that it happened, never what the document said.
    const joined = JSON.stringify(events.results);
    expect(joined).not.toContain("body of purge-audit-1");
  });

  it("is idempotent: running it again purges nothing and does not fail", async () => {
    const { admin, service, id } = await publishedDocument("purge-idem-1", "purge-admin-4");
    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await backdateTrash(id, LIMITS.TRASH_RETENTION_HOURS + 1);

    const first = await purgeExpiredTrash(testEnv);
    expect(first.purged).toContain(id);
    expect(first.failures).toHaveLength(0);

    const second = await purgeExpiredTrash(testEnv);
    expect(second.purged).not.toContain(id);
    expect(second.failures).toHaveLength(0);
  });

  it("survives an object that has already been deleted", async () => {
    const { admin, service, repo, id } = await publishedDocument("purge-retry-1", "purge-admin-5");
    const keys = await repo.allR2Keys(id);
    const storage = new R2DocumentStorage(testEnv.DOCS);
    // Simulate a run that died between deleting R2 and deleting D1.
    for (const key of keys) await storage.delete(key);

    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await backdateTrash(id, LIMITS.TRASH_RETENTION_HOURS + 1);

    const outcome = await purgeExpiredTrash(testEnv);
    expect(outcome.purged).toContain(id);
    expect(outcome.failures).toHaveLength(0);
  });

  it("detaches a policy that cited the document rather than deleting the policy", async () => {
    const { admin, service, id } = await publishedDocument("purge-policy-1", "purge-admin-6");
    await testEnv.DB.prepare(
      `INSERT INTO policies (id, code, title, body_markdown, document_id, classification, status)
       VALUES ('pol-purge-1', 'purge-policy-code', 'Cites the document', 'text', ?1, 'PUBLIC', 'active')`
    ).bind(id).run();

    await service.moveToTrash(admin.principal, id, admin.principal.agentId);
    await backdateTrash(id, LIMITS.TRASH_RETENTION_HOURS + 1);
    const outcome = await purgeExpiredTrash(testEnv);
    expect(outcome.purged).toContain(id);

    const policy = await testEnv.DB.prepare("SELECT document_id FROM policies WHERE id = 'pol-purge-1'")
      .first<{ document_id: string | null }>();
    expect(policy).not.toBeNull();
    expect(policy?.document_id).toBeNull();
  });
});
