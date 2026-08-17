import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentsService } from "../../src/knowledge/documents";
import { DocumentsRepository } from "../../src/repositories/documents.repository";
import { IngestionRepository } from "../../src/repositories/ingestion.repository";
import { R2DocumentStorage } from "../../src/storage/r2";
import { ApiError, ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import { createAgent, seedSecurityFixtures } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

function textContent(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * DocumentsService.createDraft / submitForReview are the only write path MCP
 * can reach (src/mcp/server.ts's knowledge_propose_document and
 * knowledge_submit_document_for_review) -- transport-parity.test.ts pins that
 * MCP never touches PUBLISH_WORKFLOW or a repository directly, so this is the
 * one place that actually exercises what an AI agent proposing a document can
 * and cannot do.
 */
describe("DocumentsService write path (human-in-the-loop publish)", () => {
  beforeAll(async () => {
    await seedSecurityFixtures(testEnv);
  });

  function buildService(): DocumentsService {
    return new DocumentsService(new DocumentsRepository(testEnv.DB), new IngestionRepository(testEnv.DB), new R2DocumentStorage(testEnv.DOCS), testEnv);
  }

  it("a content-contributor can draft a document and submit it for review", async () => {
    const contributor = await createAgent(testEnv, "write-path-contributor-1", "content-contributor");
    const service = buildService();

    const draft = await service.createDraft(
      contributor.principal,
      {
        slug: "write-path-doc-1",
        title: "Proposed doc",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("proposed content"),
        contentType: "text/markdown"
      },
      contributor.principal.agentId
    );
    expect(draft.status).toBe("draft");

    const submission = await service.submitForReview(contributor.principal, draft.id, contributor.principal.agentId);
    expect(submission.documentId).toBe(draft.id);
    // The Workflow instance id IS the document id, so the
    // review-decision endpoint can address it without a lookup table. The
    // actual draft -> pending_review transition happens inside the Workflow's
    // own first step (asynchronous durable execution), not synchronously here.
    expect(submission.workflowInstanceId).toBe(draft.id);
  });

  it("rejects a duplicate slug with CONFLICT rather than a raw constraint error", async () => {
    const contributor = await createAgent(testEnv, "write-path-contributor-2", "content-contributor");
    const service = buildService();

    await service.createDraft(
      contributor.principal,
      {
        slug: "write-path-doc-dup",
        title: "First",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("v1"),
        contentType: "text/markdown"
      },
      contributor.principal.agentId
    );

    await expect(
      service.createDraft(
        contributor.principal,
        {
          slug: "write-path-doc-dup",
          title: "Second",
          domain: "public",
          classification: "PUBLIC",
          language: "en",
          content: textContent("v2"),
          contentType: "text/markdown"
        },
        contributor.principal.agentId
      )
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it("an agent without documents.write cannot draft a document", async () => {
    const reader = await createAgent(testEnv, "write-path-reader-1", "support-agent");
    const service = buildService();

    await expect(
      service.createDraft(
        reader.principal,
        {
          slug: "write-path-doc-should-not-exist",
          title: "Should be refused",
          domain: "public",
          classification: "PUBLIC",
          language: "en",
          content: textContent("x"),
          contentType: "text/markdown"
        },
        reader.principal.agentId
      )
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it("an agent without documents.write cannot submit someone else's draft for review", async () => {
    const contributor = await createAgent(testEnv, "write-path-contributor-3", "content-contributor");
    const reader = await createAgent(testEnv, "write-path-reader-2", "support-agent");
    const service = buildService();

    const draft = await service.createDraft(
      contributor.principal,
      {
        slug: "write-path-doc-2",
        title: "Proposed doc 2",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("content"),
        contentType: "text/markdown"
      },
      contributor.principal.agentId
    );

    await expect(service.submitForReview(reader.principal, draft.id, reader.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });

  it("submitForReview on an unknown document id is NOT_FOUND, not an internal error", async () => {
    const contributor = await createAgent(testEnv, "write-path-contributor-4", "content-contributor");
    const service = buildService();

    await expect(service.submitForReview(contributor.principal, "does-not-exist", contributor.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND
    });
  });

  it("cannot submit an already-active document for review", async () => {
    const admin = await createAgent(testEnv, "write-path-admin-1", "knowledge-admin");
    const service = buildService();

    const draft = await service.createDraft(
      admin.principal,
      {
        slug: "write-path-doc-active",
        title: "Already active",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("content"),
        contentType: "text/markdown"
      },
      admin.principal.agentId
    );
    await new DocumentsRepository(testEnv.DB).setStatus(draft.id, "active", admin.principal.agentId);

    await expect(service.submitForReview(admin.principal, draft.id, admin.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT
    });
  });

  /**
   * The core human-in-the-loop guarantee: a content-contributor can propose
   * and submit, but the SAME principal is refused if it tries to finish the
   * job itself by transitioning the document straight to active -- publishing
   * requires documents.publish, which this role deliberately does not hold.
   * MCP never exposes transitionStatus at all (transport-parity.test.ts), so
   * this failure mode is defense in depth, not the only guard.
   */
  it("a content-contributor cannot publish its own proposed document", async () => {
    const contributor = await createAgent(testEnv, "write-path-contributor-5", "content-contributor");
    const service = buildService();

    const draft = await service.createDraft(
      contributor.principal,
      {
        slug: "write-path-doc-self-publish",
        title: "Should not self-publish",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("content"),
        contentType: "text/markdown"
      },
      contributor.principal.agentId
    );
    await service.submitForReview(contributor.principal, draft.id, contributor.principal.agentId);

    await expect(service.transitionStatus(contributor.principal, draft.id, "active", contributor.principal.agentId)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });

    // The rejected publish attempt touched nothing: assertAuthorized runs
    // before any write, so status is whatever it already was.
    const repo = new DocumentsRepository(testEnv.DB);
    const untouched = await repo.getById(draft.id);
    expect(untouched?.status).not.toBe("active");
  });
});

/** Sanity: ApiError instances actually carry `.code` the way the matchers above assume. */
describe("ApiError sanity", () => {
  it("carries a stable .code", () => {
    const error = new ApiError(ErrorCode.CONFLICT, "x");
    expect(error.code).toBe(ErrorCode.CONFLICT);
  });
});

/**
 * Editing. The rule that matters is that an edit ADDS a version rather than
 * rewriting one: the previous bytes must still be fetchable afterwards, or
 * rollback has nothing to roll back to.
 */
describe("DocumentsService.createNewVersion (editing)", () => {
  // Fixtures are seeded once by the write-path suite above; seeding again here
  // re-applies the schema and fails on the existing tables.
  function buildService(): DocumentsService {
    return new DocumentsService(new DocumentsRepository(testEnv.DB), new IngestionRepository(testEnv.DB), new R2DocumentStorage(testEnv.DOCS), testEnv);
  }

  async function seedDraft(slug: string, contributorKey: string) {
    const contributor = await createAgent(testEnv, contributorKey, "content-contributor");
    const service = buildService();
    const draft = await service.createDraft(
      contributor.principal,
      {
        slug,
        title: "Original title",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("original body"),
        contentType: "text/markdown"
      },
      contributor.principal.agentId
    );
    return { contributor, service, draft };
  }

  it("adds a version and leaves the previous version's bytes untouched", async () => {
    const { contributor, service, draft } = await seedDraft("edit-doc-1", "edit-contributor-1");
    const repo = new DocumentsRepository(testEnv.DB);
    const storage = new R2DocumentStorage(testEnv.DOCS);
    const before = await repo.getById(draft.id);
    expect(before).not.toBeNull();
    const originalKey = before?.r2_key ?? "";

    const updated = await service.createNewVersion(
      contributor.principal,
      draft.id,
      { content: textContent("revised body"), contentType: "text/markdown", changeNote: "fixed a typo", expectedVersion: draft.version },
      contributor.principal.agentId
    );

    expect(updated.version).toBe(draft.version + 1);

    const row = await repo.getById(draft.id);
    expect(row).not.toBeNull();
    expect(row?.r2_key).not.toBe(originalKey);

    // The whole point: history is still readable at its own key.
    const oldBytes = await storage.get(originalKey);
    expect(oldBytes).not.toBeNull();
    expect(await new Response(oldBytes).text()).toBe("original body");

    const newBytes = await storage.get(row?.r2_key ?? "");
    expect(await new Response(newBytes).text()).toBe("revised body");
  });

  it("records the edit in version history with its change note", async () => {
    const { contributor, service, draft } = await seedDraft("edit-doc-2", "edit-contributor-2");
    await service.createNewVersion(
      contributor.principal,
      draft.id,
      { content: textContent("v2 body"), contentType: "text/markdown", changeNote: "second pass", expectedVersion: draft.version },
      contributor.principal.agentId
    );

    const repo = new DocumentsRepository(testEnv.DB);
    const v2 = await repo.getVersion(draft.id, draft.version + 1);
    expect(v2?.change_note).toBe("second pass");
    // v1 still exists, so rollback has a target.
    expect(await repo.getVersion(draft.id, draft.version)).not.toBeNull();
  });

  it("refuses a concurrent edit with STALE_VERSION rather than overwriting", async () => {
    const { contributor, service, draft } = await seedDraft("edit-doc-3", "edit-contributor-3");
    // Two editors both loaded v1.
    await service.createNewVersion(
      contributor.principal,
      draft.id,
      { content: textContent("editor A"), contentType: "text/markdown", expectedVersion: draft.version },
      contributor.principal.agentId
    );

    await expect(
      service.createNewVersion(
        contributor.principal,
        draft.id,
        { content: textContent("editor B"), contentType: "text/markdown", expectedVersion: draft.version },
        contributor.principal.agentId
      )
    ).rejects.toMatchObject({ code: ErrorCode.STALE_VERSION });
  });

  it("an agent without documents.write cannot edit", async () => {
    const { service, draft } = await seedDraft("edit-doc-4", "edit-contributor-4");
    const reader = await createAgent(testEnv, "edit-reader-1", "support-agent");

    await expect(
      service.createNewVersion(
        reader.principal,
        draft.id,
        { content: textContent("not allowed"), contentType: "text/markdown", expectedVersion: draft.version },
        reader.principal.agentId
      )
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it("editing an unknown document is NOT_FOUND", async () => {
    const contributor = await createAgent(testEnv, "edit-contributor-5", "content-contributor");
    const service = buildService();
    await expect(
      service.createNewVersion(
        contributor.principal,
        "does-not-exist",
        { content: textContent("x"), contentType: "text/markdown", expectedVersion: 1 },
        contributor.principal.agentId
      )
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it("inherits classification: editing never moves a document between tiers", async () => {
    const { contributor, service, draft } = await seedDraft("edit-doc-6", "edit-contributor-6");
    const updated = await service.createNewVersion(
      contributor.principal,
      draft.id,
      { content: textContent("still public"), contentType: "text/markdown", expectedVersion: draft.version },
      contributor.principal.agentId
    );
    expect(updated.classification).toBe(draft.classification);
  });

  it("queues a reindex only once the document is published", async () => {
    const admin = await createAgent(testEnv, "edit-admin-1", "knowledge-admin");
    const service = buildService();
    const jobCount = async (): Promise<number> => {
      const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM ingestion_jobs WHERE document_id = ?").bind(draft.id).first<{ n: number }>();
      return row?.n ?? 0;
    };
    const draft = await service.createDraft(
      admin.principal,
      {
        slug: "edit-doc-7",
        title: "Reindex on edit",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("v1"),
        contentType: "text/markdown"
      },
      admin.principal.agentId
    );

    const before = await jobCount();
    // Editing a draft indexes nothing, because a draft is not in the index.
    await service.createNewVersion(
      admin.principal,
      draft.id,
      { content: textContent("v2 draft"), contentType: "text/markdown", expectedVersion: draft.version },
      admin.principal.agentId
    );
    expect(await jobCount()).toBe(before);

    await new DocumentsRepository(testEnv.DB).setStatus(draft.id, "active", admin.principal.agentId);
    const afterPublish = await jobCount();

    // Editing a published document must correct the index, or search keeps
    // answering from the previous version's bytes.
    await service.createNewVersion(
      admin.principal,
      draft.id,
      { content: textContent("v3 published"), contentType: "text/markdown", expectedVersion: draft.version + 1 },
      admin.principal.agentId
    );
    expect(await jobCount()).toBe(afterPublish + 1);
  });
});

/**
 * Rollback. The property that matters is that restoring is another append: the
 * version being replaced must survive, and the restored bytes must be the
 * ORIGINAL R2 object rather than a copy, or "immutable history" is only a
 * claim.
 */
describe("DocumentsService.rollback (restoring a version)", () => {
  function buildService(): DocumentsService {
    return new DocumentsService(new DocumentsRepository(testEnv.DB), new IngestionRepository(testEnv.DB), new R2DocumentStorage(testEnv.DOCS), testEnv);
  }

  async function seedTwoVersions(slug: string, agentKey: string) {
    const admin = await createAgent(testEnv, agentKey, "knowledge-admin");
    const service = buildService();
    const draft = await service.createDraft(
      admin.principal,
      {
        slug,
        title: "First title",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("first content"),
        contentType: "text/markdown"
      },
      admin.principal.agentId
    );
    const v2 = await service.createNewVersion(
      admin.principal,
      draft.id,
      { content: textContent("second content"), contentType: "text/markdown", changeNote: "second", title: "Second title", expectedVersion: draft.version },
      admin.principal.agentId
    );
    return { admin, service, draft, v2 };
  }

  it("restores prior content as a NEW version, keeping the replaced one", async () => {
    const { admin, service, draft, v2 } = await seedTwoVersions("rb-doc-1", "rb-admin-1");
    const repo = new DocumentsRepository(testEnv.DB);

    const restored = await service.rollback(admin.principal, draft.id, draft.version, admin.principal.agentId);

    // A third version, not a rewind of the counter.
    expect(restored.version).toBe(v2.version + 1);
    expect(restored.title).toBe("First title");

    // Everything that existed still exists.
    expect(await repo.getVersion(draft.id, draft.version)).not.toBeNull();
    expect(await repo.getVersion(draft.id, v2.version)).not.toBeNull();
    expect(await repo.getVersion(draft.id, restored.version)).not.toBeNull();
  });

  it("points at the original R2 object rather than writing a copy", async () => {
    const { admin, service, draft } = await seedTwoVersions("rb-doc-2", "rb-admin-2");
    const repo = new DocumentsRepository(testEnv.DB);
    const v1 = await repo.getVersion(draft.id, draft.version);

    const restored = await service.rollback(admin.principal, draft.id, draft.version, admin.principal.agentId);
    const restoredRow = await repo.getVersion(draft.id, restored.version);

    // Same key: the historical object is reused, never rewritten.
    expect(restoredRow?.r2_key).toBe(v1?.r2_key);

    const storage = new R2DocumentStorage(testEnv.DOCS);
    const bytes = await storage.get(v1?.r2_key ?? "");
    expect(await new Response(bytes).text()).toBe("first content");
  });

  it("records the restore in history with a note naming the source version", async () => {
    const { admin, service, draft } = await seedTwoVersions("rb-doc-3", "rb-admin-3");
    const repo = new DocumentsRepository(testEnv.DB);
    const restored = await service.rollback(admin.principal, draft.id, draft.version, admin.principal.agentId);
    const row = await repo.getVersion(draft.id, restored.version);
    expect(row?.change_note).toContain(`rollback to v${draft.version}`);
  });

  it("refuses when the document moved on since the operator looked", async () => {
    const { admin, service, draft, v2 } = await seedTwoVersions("rb-doc-4", "rb-admin-4");
    // The operator opened history while v2 was current, then someone published v3.
    await service.createNewVersion(
      admin.principal,
      draft.id,
      { content: textContent("third content"), contentType: "text/markdown", expectedVersion: v2.version },
      admin.principal.agentId
    );

    await expect(
      service.rollback(admin.principal, draft.id, draft.version, admin.principal.agentId, v2.version)
    ).rejects.toMatchObject({ code: ErrorCode.STALE_VERSION });
  });

  it("proceeds when the expected version still matches", async () => {
    const { admin, service, draft, v2 } = await seedTwoVersions("rb-doc-5", "rb-admin-5");
    const restored = await service.rollback(admin.principal, draft.id, draft.version, admin.principal.agentId, v2.version);
    expect(restored.version).toBe(v2.version + 1);
  });

  it("an agent without documents.write cannot roll back", async () => {
    const { service, draft } = await seedTwoVersions("rb-doc-6", "rb-admin-6");
    const reader = await createAgent(testEnv, "rb-reader-1", "support-agent");
    await expect(
      service.rollback(reader.principal, draft.id, draft.version, reader.principal.agentId)
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it("queues a reindex when the document is published, and not when it is a draft", async () => {
    const { admin, service, draft, v2 } = await seedTwoVersions("rb-doc-7", "rb-admin-7");
    const jobCount = async (): Promise<number> => {
      const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM ingestion_jobs WHERE document_id = ?").bind(draft.id).first<{ n: number }>();
      return row?.n ?? 0;
    };

    const beforeDraftRollback = await jobCount();
    await service.rollback(admin.principal, draft.id, draft.version, admin.principal.agentId);
    expect(await jobCount()).toBe(beforeDraftRollback);

    await new DocumentsRepository(testEnv.DB).setStatus(draft.id, "active", admin.principal.agentId);
    const afterPublish = await jobCount();

    // Restoring published content changes what search must return.
    await service.rollback(admin.principal, draft.id, v2.version, admin.principal.agentId);
    expect(await jobCount()).toBe(afterPublish + 1);
  });
});

/**
 * Version history is as sensitive as the document. It carries every past title
 * and classification, so a caller who cannot read the document must not be able
 * to read what it used to say -- and must not learn it exists.
 */
describe("version history is bounded by the same clearance as the document", () => {
  it("answers NOT_FOUND for a principal that cannot read the document", async () => {
    const admin = await createAgent(testEnv, "vh-admin-1", "knowledge-admin");
    const service = new DocumentsService(
      new DocumentsRepository(testEnv.DB),
      new IngestionRepository(testEnv.DB),
      new R2DocumentStorage(testEnv.DOCS),
      testEnv
    );
    const draft = await service.createDraft(
      admin.principal,
      {
        slug: "vh-restricted-doc",
        title: "Restricted history",
        domain: "internal",
        classification: "RESTRICTED",
        language: "en",
        content: textContent("secret"),
        contentType: "text/markdown"
      },
      admin.principal.agentId
    );

    // A content-contributor HOLDS admin.documents, so it gets past the
    // administrative gate and reaches the per-document check. That is the
    // interesting case: the denial must be masked as NOT_FOUND rather than
    // FORBIDDEN, or the response confirms a RESTRICTED document exists.
    const limited = await createAgent(testEnv, "vh-reader-1", "content-contributor");
    await expect(service.listVersions(limited.principal, draft.id)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
      publicCode: ErrorCode.NOT_FOUND
    });

    // A principal with no administrative reach at all is refused earlier, at
    // the gate, which is also correct -- it never learns the id resolves.
    const outsider = await createAgent(testEnv, "vh-reader-2", "support-agent");
    await expect(service.listVersions(outsider.principal, draft.id)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });

  it("returns history to a principal that can read the document, marking the current version", async () => {
    const admin = await createAgent(testEnv, "vh-admin-2", "knowledge-admin");
    const service = new DocumentsService(
      new DocumentsRepository(testEnv.DB),
      new IngestionRepository(testEnv.DB),
      new R2DocumentStorage(testEnv.DOCS),
      testEnv
    );
    const draft = await service.createDraft(
      admin.principal,
      {
        slug: "vh-public-doc",
        title: "Readable history",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("v1"),
        contentType: "text/markdown"
      },
      admin.principal.agentId
    );
    await service.createNewVersion(
      admin.principal,
      draft.id,
      { content: textContent("v2"), contentType: "text/markdown", changeNote: "revised", expectedVersion: draft.version },
      admin.principal.agentId
    );

    const versions = await service.listVersions(admin.principal, draft.id);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    // Newest first, and exactly one entry claims to be current.
    expect(versions[0]?.version).toBeGreaterThan(versions[1]?.version ?? 0);
    expect(versions.filter((v) => v.isCurrent)).toHaveLength(1);
    expect(versions.find((v) => v.isCurrent)?.version).toBe(draft.version + 1);
    // No storage paths are handed to the client.
    expect(JSON.stringify(versions)).not.toContain("knowledge/");
  });
});
