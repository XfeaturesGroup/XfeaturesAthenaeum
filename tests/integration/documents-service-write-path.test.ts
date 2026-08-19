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
