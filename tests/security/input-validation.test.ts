import { describe, expect, it } from "vitest";
import { slugLikeSchema } from "../../src/api/schemas/common";
import { searchRequestSchema } from "../../src/api/schemas/search";
import { validateUploadCandidate } from "../../src/ingestion/validation";
import { LIMITS } from "../../src/config";
import { ApiError } from "../../src/utils/responses";

describe("slugLikeSchema rejects unsafe identifiers", () => {
  it("accepts ordinary identifiers", () => {
    expect(slugLikeSchema.safeParse("demo-widget-basic").success).toBe(true);
    expect(slugLikeSchema.safeParse("v1.2.3").success).toBe(true);
  });

  it("rejects SQL-injection-shaped input", () => {
    expect(slugLikeSchema.safeParse("x' OR '1'='1").success).toBe(false);
    expect(slugLikeSchema.safeParse("'; DROP TABLE facts; --").success).toBe(false);
  });

  it("rejects path traversal shaped input", () => {
    expect(slugLikeSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(slugLikeSchema.safeParse("a/b").success).toBe(false);
  });

  it("rejects an empty string and an oversized string", () => {
    expect(slugLikeSchema.safeParse("").success).toBe(false);
    expect(slugLikeSchema.safeParse("a".repeat(201)).success).toBe(false);
  });
});

describe("searchRequestSchema bounds the query", () => {
  it("rejects an empty query", () => {
    expect(searchRequestSchema.safeParse({ query: "" }).success).toBe(false);
  });

  it("rejects a query over the configured maximum length", () => {
    expect(searchRequestSchema.safeParse({ query: "a".repeat(LIMITS.QUERY_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it("rejects a domain outside the fixed enum (no arbitrary client-supplied domains)", () => {
    expect(searchRequestSchema.safeParse({ query: "hello", domain: "not-a-real-domain" }).success).toBe(false);
  });

  it("accepts a well-formed request", () => {
    expect(searchRequestSchema.safeParse({ query: "refund policy", domain: "support", limit: 5 }).success).toBe(true);
  });
});

describe("validateUploadCandidate (no path traversal, no unauthorized filenames/types)", () => {
  it("rejects a filename containing path traversal", () => {
    expect(() => validateUploadCandidate({ filename: "../../secret.md", mimeType: "text/markdown", size: 10 })).toThrow(ApiError);
  });

  it("rejects a filename with an embedded path separator", () => {
    expect(() => validateUploadCandidate({ filename: "a/b.md", mimeType: "text/markdown", size: 10 })).toThrow(ApiError);
  });

  it("rejects a disallowed extension", () => {
    expect(() => validateUploadCandidate({ filename: "malware.exe", mimeType: "application/octet-stream", size: 10 })).toThrow(ApiError);
  });

  it("rejects a disallowed MIME type even with an allowed extension", () => {
    expect(() => validateUploadCandidate({ filename: "doc.md", mimeType: "application/x-msdownload", size: 10 })).toThrow(ApiError);
  });

  it("rejects an empty file", () => {
    expect(() => validateUploadCandidate({ filename: "doc.md", mimeType: "text/markdown", size: 0 })).toThrow(ApiError);
  });

  it("rejects a file over the configured size limit", () => {
    expect(() =>
      validateUploadCandidate({ filename: "doc.md", mimeType: "text/markdown", size: LIMITS.UPLOAD_MAX_BYTES + 1 })
    ).toThrow(ApiError);
  });

  it("accepts a well-formed markdown upload", () => {
    expect(() => validateUploadCandidate({ filename: "doc.md", mimeType: "text/markdown", size: 1024 })).not.toThrow();
  });
});
