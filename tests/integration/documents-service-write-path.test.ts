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
