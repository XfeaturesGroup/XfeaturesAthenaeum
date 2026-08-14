import { describe, expect, it, vi } from "vitest";
// Source inlined at build time: workerd has no filesystem.
import AUTHENTICATE_SRC from "../../src/auth/authenticate.ts?raw";
import ACCESS_JWT_SRC from "../../src/auth/access-jwt.ts?raw";
import RPC_CREDENTIAL_SRC from "../../src/auth/rpc-credential.ts?raw";
import ADMIN_AGENTS_SRC from "../../src/api/routes/admin/agents.ts?raw";
import { log, logSecurityEvent, SecurityEvent } from "../../src/utils/logging";
import { ApiError, ErrorCode, errorResponse } from "../../src/utils/responses";

/**
 * Nothing secret, and no internal implementation detail,
 * may reach a client response or a log line.
 */
describe("error responses disclose nothing internal", () => {
  const cases: { name: string; error: ApiError }[] = [
    { name: "forbidden", error: new ApiError(ErrorCode.FORBIDDEN, "Access denied", { authzReason: "MISSING_SCOPE_PERMISSION" }) },
    { name: "not found", error: new ApiError(ErrorCode.NOT_FOUND, "Fact not found.") },
    { name: "invalid request", error: new ApiError(ErrorCode.INVALID_REQUEST, "Request validation failed.", { issues: ["namespace: bad"] }) },
    { name: "conflict", error: new ApiError(ErrorCode.CONFLICT, "Already exists.") },
    { name: "stale version", error: new ApiError(ErrorCode.STALE_VERSION, "This fact was modified concurrently; re-read it and retry.") },
    { name: "rate limited", error: new ApiError(ErrorCode.RATE_LIMITED, "Rate limit exceeded, try again shortly.") },
    { name: "dependency down", error: new ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "Search index is temporarily unavailable.") },
    { name: "internal", error: new ApiError(ErrorCode.INTERNAL_ERROR, "Internal error.") }
  ];

  for (const testCase of cases) {
    it(`${testCase.name} exposes only code, message and request_id`, async () => {
      const response = errorResponse(testCase.error, "req-123");
      const body = await response.json<Record<string, unknown>>();

      expect(Object.keys(body)).toEqual(["error"]);
      const errorBody = body["error"] as Record<string, unknown>;
      expect(Object.keys(errorBody).sort()).toEqual(["code", "message", "request_id"]);
    });

    it(`${testCase.name} never serializes ApiError.details`, async () => {
      const response = errorResponse(testCase.error, "req-123");
      const text = await response.text();
      expect(text).not.toContain("authzReason");
      expect(text).not.toContain("MISSING_SCOPE_PERMISSION");
      expect(text).not.toContain("issues");
    });
  }

  it("no error message contains SQL, a stack trace, or storage internals", async () => {
    for (const testCase of cases) {
      const text = await errorResponse(testCase.error, "req-1").text();
      const lowered = text.toLowerCase();
      for (const forbidden of ["select ", "insert ", "sqlite", "d1_error", "r2_key", "knowledge/", "at object.", ".ts:"]) {
        expect(lowered).not.toContain(forbidden);
      }
    }
  });

  it("a masked authorization denial reports NOT_FOUND to the client", async () => {
    const masked = new ApiError(ErrorCode.FORBIDDEN, "Document not found.", { authzReason: "X" }, ErrorCode.NOT_FOUND);
    const response = errorResponse(masked, "req-1");
    expect(response.status).toBe(404);
    const body = await response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("responses set a nosniff content-type guard", () => {
    const response = errorResponse(new ApiError(ErrorCode.NOT_FOUND, "x"), "req-1");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("the logger redacts credential-bearing fields", () => {
  const SENSITIVE = {
    authorization: "Bearer supersecret",
    cookie: "session=abc",
    "cf-access-jwt-assertion": "eyJhbGciOi.payload.signature",
    "cf-access-client-secret": "client-secret-value",
    rpc_key: "raw-rpc-key-value",
    token: "raw-token",
    password: "hunter2",
    secret: "shhh"
  };

  for (const [field, value] of Object.entries(SENSITIVE)) {
    it(`redacts "${field}"`, () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      log.info("test_event", { [field]: value });
      const line = spy.mock.calls[0]?.[0] as string;
      spy.mockRestore();

      expect(line).toContain("[redacted]");
      expect(line).not.toContain(value);
    });
  }

  it("security events also redact", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logSecurityEvent(SecurityEvent.INVALID_TOKEN, { rpc_key: "raw-secret-here", agent_key: "support-prod" });
    const line = spy.mock.calls[0]?.[0] as string;
    spy.mockRestore();

    expect(line).not.toContain("raw-secret-here");
    // Non-secret identifiers remain, since they are what makes an alert actionable.
    expect(line).toContain("support-prod");
  });
});

/** Static guarantee that no secret-bearing value is ever handed to a logger. */
describe("source-level secret handling", () => {
  const files = [
    { relative: "src/auth/authenticate.ts", source: AUTHENTICATE_SRC },
    { relative: "src/auth/access-jwt.ts", source: ACCESS_JWT_SRC },
    { relative: "src/auth/rpc-credential.ts", source: RPC_CREDENTIAL_SRC },
    { relative: "src/api/routes/admin/agents.ts", source: ADMIN_AGENTS_SRC }
  ];

  for (const file of files) {
    it(`${file.relative} never logs a raw key or token value`, () => {
      // No log call may reference the raw secret variables by name.
      const logCalls = [...file.source.matchAll(/log(?:SecurityEvent)?[.\w]*\(([^;]*?)\)/gs)].map((m) => m[1] ?? "");
      for (const call of logCalls) {
        expect(call).not.toMatch(/\brpcKey\b/);
        expect(call).not.toMatch(/\bpepper\b/);
        expect(call).not.toMatch(/RPC_KEY_PEPPER/);
        expect(call).not.toMatch(/\btoken\b\s*[,)]/);
      }
    });
  }

  it("the generated rpc key is hashed before storage and never persisted raw", () => {
    // Persisted value is the peppered hash, not the key itself.
    expect(ADMIN_AGENTS_SRC).toContain("rpcKeyHash = await hashRpcKey(rpcKey, ctx.env.RPC_KEY_PEPPER)");
    expect(ADMIN_AGENTS_SRC).toContain("rpcKeyHash,");
    // The raw key is never handed to the repository.
    expect(ADMIN_AGENTS_SRC).not.toMatch(/rpcKey:\s*rpcKey/);
  });

  it("no route projects the stored key hash back into a response", () => {
    // Comments legitimately mention the column name, so strip them and look
    // for an actual property read/projection rather than any occurrence.
    const codeOnly = ADMIN_AGENTS_SRC.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toMatch(/\brow\.rpc_key_hash\b/);
    expect(codeOnly).not.toMatch(/\bagent\.rpc_key_hash\b/);
    expect(codeOnly).not.toMatch(/rpc_key_hash:/);
  });

  it("no source file contains a hardcoded credential-looking literal", () => {
    const suspicious = /(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/i;
    for (const file of files) {
      expect(file.source).not.toMatch(suspicious);
    }
  });
});
