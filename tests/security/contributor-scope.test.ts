import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentsService } from "../../src/knowledge/documents";
import { DocumentsRepository } from "../../src/repositories/documents.repository";
import { IngestionRepository } from "../../src/repositories/ingestion.repository";
import { R2DocumentStorage } from "../../src/storage/r2";
import { ErrorCode } from "../../src/utils/responses";
import type { Env } from "../../src/env";
import { createAgent, seedSecurityFixtures, type SeededAgent } from "../helpers/fixtures";

const testEnv = env as unknown as Env;

/**
 * SR-025 regression.
 *
 * The MCP tool list is not a security boundary. `content-contributor` is the
 * role an AI agent gets in order to PROPOSE knowledge over MCP, and MCP
 * exposes exactly two write tools for it: propose a draft, submit that draft
 * for review. But a role is attached to a credential, not to a transport --
 * the same Account token, sent to REST or through the published SDK, gets
 * whatever the role actually holds.
 *
 * Before the fix the role held `documents.write` + `admin.documents` +
 * `documents.read.*`, which over REST is enough to rewrite the content of
 * every INTERNAL document in every domain, enumerate the whole corpus
 * including drafts, and read any draft's full text. A compromised proposing
 * agent was therefore a corpus-wide integrity compromise, not a nuisance that
 * files bad drafts.
 *
 * These tests assert the capability the role is SUPPOSED to have, and the
 * capabilities it must not have on any transport.
 */
function buildService(): DocumentsService {
  return new DocumentsService(
    new DocumentsRepository(testEnv.DB),
    new IngestionRepository(testEnv.DB),
    new R2DocumentStorage(testEnv.DOCS),
    testEnv
  );
}

function textContent(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

let contributor: SeededAgent;
let admin: SeededAgent;
/** A published, PUBLIC, public-domain document — one the contributor can legitimately READ. */
let targetDocumentId: string;

beforeAll(async () => {
  await seedSecurityFixtures(testEnv);
  contributor = await createAgent(testEnv, "sr025-contributor", "content-contributor");
  admin = await createAgent(testEnv, "sr025-admin", "knowledge-admin");

  const service = buildService();
  const target = await service.createDraft(
    admin.principal,
    {
      slug: "sr025-existing-doc",
      title: "Someone else's document",
      domain: "public",
      classification: "PUBLIC",
      language: "en",
      content: textContent("authoritative content"),
      contentType: "text/markdown"
    },
    admin.principal.agentId
  );
  await new DocumentsRepository(testEnv.DB).setStatus(target.id, "active", admin.principal.agentId);
  targetDocumentId = target.id;
});

describe("SR-025: what a content-contributor may do", () => {
  it("creates a draft", async () => {
    const draft = await buildService().createDraft(
      contributor.principal,
      {
        slug: "sr025-proposed",
        title: "Proposed",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("a proposal"),
        contentType: "text/markdown"
      },
      contributor.principal.agentId
    );
    expect(draft.status).toBe("draft");
  });

  it("submits its own draft for human review", async () => {
    const service = buildService();
    const draft = await service.createDraft(
      contributor.principal,
      {
        slug: "sr025-proposed-2",
        title: "Proposed 2",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("another proposal"),
        contentType: "text/markdown"
      },
      contributor.principal.agentId
    );
    const submission = await service.submitForReview(contributor.principal, draft.id, contributor.principal.agentId);
    expect(submission.documentId).toBe(draft.id);
  });
});

describe("SR-025: what a content-contributor must NOT do on any transport", () => {
  it("cannot rewrite an existing document it did not author, even one it can read", async () => {
    await expect(
      buildService().createNewVersion(
        contributor.principal,
        targetDocumentId,
        { content: textContent("tampered content"), contentType: "text/markdown", expectedVersion: 1 },
        contributor.principal.agentId
      )
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it("leaves the document's bytes untouched after the refused edit", async () => {
    const row = await new DocumentsRepository(testEnv.DB).getById(targetDocumentId);
    expect(row?.version).toBe(1);
    const stream = await new R2DocumentStorage(testEnv.DOCS).get(row?.r2_key ?? "");
    expect(await new Response(stream).text()).toBe("authoritative content");
  });

  it("cannot enumerate the corpus through the administrative listing", async () => {
    await expect(buildService().listDocuments(contributor.principal, { limit: 50, offset: 0 })).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });

  it("cannot open another author's document through the administrative read", async () => {
    await expect(buildService().getAdminDocument(contributor.principal, targetDocumentId)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });

  it("cannot read another document's version history", async () => {
    await expect(buildService().listVersions(contributor.principal, targetDocumentId)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN
    });
  });

  it("cannot roll a document back to an earlier version", async () => {
    await expect(
      buildService().rollback(contributor.principal, targetDocumentId, 1, contributor.principal.agentId)
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});

/**
 * The counterpart: narrowing the contributor must not disarm the roles that
 * are supposed to edit. If this suite passes while the one above fails, the
 * fix removed a capability from the wrong place.
 */
describe("SR-025: editing still works for a role that is meant to edit", () => {
  it("a knowledge-admin can still add a version to the same document", async () => {
    const repo = new DocumentsRepository(testEnv.DB);
    const before = await repo.getById(targetDocumentId);
    const currentVersion = before?.version ?? 0;

    const updated = await buildService().createNewVersion(
      admin.principal,
      targetDocumentId,
      { content: textContent("a legitimate revision"), contentType: "text/markdown", expectedVersion: currentVersion },
      admin.principal.agentId
    );
    expect(updated.version).toBe(currentVersion + 1);
  });

  it("a knowledge-admin can still create a draft", async () => {
    const draft = await buildService().createDraft(
      admin.principal,
      {
        slug: "sr025-admin-draft",
        title: "Admin draft",
        domain: "public",
        classification: "PUBLIC",
        language: "en",
        content: textContent("admin content"),
        contentType: "text/markdown"
      },
      admin.principal.agentId
    );
    expect(draft.status).toBe("draft");
  });
});
