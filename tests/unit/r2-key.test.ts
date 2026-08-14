import { describe, expect, it } from "vitest";
import { buildDocumentR2Key, documentR2Extension } from "../../src/storage/r2";
import { ALLOWED_UPLOAD_MIME_TYPES } from "../../src/config";

/**
 * The search index parses an object according to its key's file extension and
 * silently skips anything it does not recognise. An earlier revision wrote
 * every document as `v{n}.bin`, which stored the bytes correctly and indexed
 * none of them -- a document could be published, appear healthy in D1 and R2,
 * and never be retrievable. These tests pin the key format against the
 * indexer's supported extensions.
 *
 * https://developers.cloudflare.com/ai-search/configuration/data-source/#supported-file-types
 */
const INDEXABLE_EXTENSIONS = new Set(["md", "txt", "json", "html", "htm", "csv", "yaml", "yml", "xml"]);

describe("R2 keys carry an extension the search indexer can parse", () => {
  it("maps every accepted upload type to an indexable extension", () => {
    for (const mimeType of ALLOWED_UPLOAD_MIME_TYPES) {
      expect(INDEXABLE_EXTENSIONS.has(documentR2Extension(mimeType))).toBe(true);
    }
  });

  it("never produces the unparseable .bin extension", () => {
    for (const mimeType of [...ALLOWED_UPLOAD_MIME_TYPES, "application/octet-stream", "", "nonsense"]) {
      expect(buildDocumentR2Key("INTERNAL", "support", "doc-1", 1, mimeType).endsWith(".bin")).toBe(false);
    }
  });

  it("falls back to plain text for an unrecognised content type rather than a skipped one", () => {
    expect(documentR2Extension("application/octet-stream")).toBe("txt");
    expect(documentR2Extension("")).toBe("txt");
  });

  it("ignores content-type parameters and casing", () => {
    expect(documentR2Extension("text/markdown; charset=utf-8")).toBe("md");
    expect(documentR2Extension("TEXT/MARKDOWN")).toBe("md");
  });

  it("keeps the server-generated key shape, with no caller-supplied path segment", () => {
    const key = buildDocumentR2Key("RESTRICTED", "Network Ops/../..", "doc-1", 3, "text/markdown");
    expect(key).toBe("knowledge/restricted/network_ops______/doc-1/v3.md");
    expect(key).not.toContain("..");
  });

  it("separates versions so a new version is indexed as its own object", () => {
    const v1 = buildDocumentR2Key("PUBLIC", "public", "doc-1", 1, "text/markdown");
    const v2 = buildDocumentR2Key("PUBLIC", "public", "doc-1", 2, "text/markdown");
    expect(v1).not.toBe(v2);
  });
});
