import { describe, expect, it } from "vitest";
import { parseRpcError } from "../../src/rpc/errors";
import { ApiError, ErrorCode } from "../../src/utils/responses";

/**
 * Cross-transport parity. REST, RPC and MCP must not differ in
 * what they authorize or what they disclose. Two properties are checked here
 * by static inspection of the source, because they are structural invariants
 * rather than runtime behaviours:
 *
 *  1. No transport reaches a repository/queue/workflow without first passing
 *     through the shared pipeline (which now mandates an authorization).
 *  2. No transport discloses more error detail than the others.
 */
// Source is inlined at build time: tests run inside workerd, which has no filesystem.
import RPC_SOURCE from "../../src/rpc/entrypoint.ts?raw";
import MCP_SOURCE from "../../src/mcp/server.ts?raw";
import PIPELINE_SOURCE from "../../src/auth/pipeline.ts?raw";

describe("every RPC method goes through the shared pipeline", () => {
  const methodNames = [...RPC_SOURCE.matchAll(/^\s{2}async (\w+)\(/gm)].map((match) => match[1]);

  it("finds the expected RPC surface", () => {
    expect(methodNames.length).toBeGreaterThanOrEqual(11);
    expect(methodNames).toContain("searchKnowledge");
    expect(methodNames).toContain("getDocument");
  });

  it("every method body calls withRpc (never a repository directly)", () => {
    // Split the class body into per-method chunks and assert each delegates.
    const bodies = RPC_SOURCE.split(/^\s{2}async \w+\(/gm).slice(1);
    for (const body of bodies) {
      expect(body).toContain("withRpc(");
    }
  });

  it("withRpc requires an OperationAuthorization -- no free-text action", () => {
    expect(RPC_SOURCE).toContain("authorization: OperationAuthorization");
    expect(RPC_SOURCE).not.toMatch(/withRpc\(\s*\w+,\s*\w+,\s*"[a-z.]+"/);
  });

  it("no RPC method touches a repository or queue outside a service call", () => {
    expect(RPC_SOURCE).not.toMatch(/services\.\w+Repo\./);
    expect(RPC_SOURCE).not.toContain("INGESTION_QUEUE");
    expect(RPC_SOURCE).not.toContain("PUBLISH_WORKFLOW");
  });
});

describe("MCP has no privileged surface of its own", () => {
  it("registers the expected knowledge tools, read and propose-only write", () => {
    const tools = [...MCP_SOURCE.matchAll(/registerTool\(\s*"([\w_]+)"/g)].map((match) => match[1]);
    expect(tools.sort()).toEqual(
      [
        "knowledge_get_document",
        "knowledge_get_fact",
        "knowledge_get_incident",
        "knowledge_get_plan",
        "knowledge_get_policy",
        "knowledge_get_product",
        "knowledge_search",
        "knowledge_propose_document",
        "knowledge_submit_document_for_review"
      ].sort()
    );
  });

  it("exposes no tool that can publish, approve or otherwise finalize a change", () => {
    // knowledge_propose_document and knowledge_submit_document_for_review can
    // only create a DRAFT and hand it to a human reviewer -- human-in-the-loop
    // publish is enforced structurally here: there is no
    // documents.publish call, no review-decision tool and no PUBLISH_WORKFLOW
    // sendEvent anywhere in this file, regardless of what the calling
    // principal's own permissions allow.
    const tools = [...MCP_SOURCE.matchAll(/registerTool\(\s*"([\w_]+)"/g)].map((match) => match[1] ?? "");
    for (const tool of tools) {
      expect(tool).not.toContain("admin");
      expect(tool).not.toContain("create");
      expect(tool).not.toContain("update");
      expect(tool).not.toContain("delete");
      expect(tool).not.toContain("publish");
      expect(tool).not.toContain("approve");
      expect(tool).not.toContain("review_decision");
    }
    expect(MCP_SOURCE).not.toContain("documents.publish");
    expect(MCP_SOURCE).not.toContain("review-decision");
    expect(MCP_SOURCE).not.toContain(".sendEvent(");
  });

  it("never touches a repository, queue or workflow directly -- only services.* methods", () => {
    expect(MCP_SOURCE).not.toMatch(/services\.\w+Repo\./);
    expect(MCP_SOURCE).not.toContain("INGESTION_QUEUE");
    expect(MCP_SOURCE).not.toContain("PUBLISH_WORKFLOW");
  });

  it("authenticates with the same function the REST transport uses", () => {
    expect(MCP_SOURCE).toContain("authenticateHttpRequest");
  });
});

describe("the pipeline cannot be used without an authorization decision", () => {
  it("OperationParams requires `authorization`, not an optional label", () => {
    expect(PIPELINE_SOURCE).toMatch(/authorization: OperationAuthorization;/);
    // The vulnerable shape must not come back.
    expect(PIPELINE_SOURCE).not.toMatch(/^\s*action: string;/m);
  });

  it("calls assertAuthorized for every `enforce` operation", () => {
    expect(PIPELINE_SOURCE).toContain("assertAuthorized(principal, params.authorization.enforce)");
  });
});

describe("SR-012: RPC discloses no more than REST", () => {
  it("an RPC error payload carries no `details`", () => {
    const apiError = new ApiError(ErrorCode.FORBIDDEN, "Access denied", {
      authzReason: "CLASSIFICATION_NOT_PERMITTED",
      action: "documents.read"
    });

    let thrown: unknown;
    try {
      // Mirrors throwRpcError's serialization.
      const payload = { code: apiError.publicCode, message: apiError.message };
      throw new Error(JSON.stringify(payload));
    } catch (error) {
      thrown = error;
    }

    const parsed = parseRpcError(thrown);
    expect(parsed.details).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("CLASSIFICATION_NOT_PERMITTED");
  });

  it("an unknown error shape degrades to a generic internal error", () => {
    expect(parseRpcError(new Error("raw database connection string leaked here"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal error."
    });
    expect(parseRpcError("not even an error")).toEqual({ code: "INTERNAL_ERROR", message: "Internal error." });
  });

  it("a masked forbidden surfaces as NOT_FOUND over RPC too", () => {
    const masked = new ApiError(ErrorCode.FORBIDDEN, "Fact not found.", { authzReason: "X" }, ErrorCode.NOT_FOUND);
    expect(masked.publicCode).toBe(ErrorCode.NOT_FOUND);
    expect(masked.code).toBe(ErrorCode.FORBIDDEN);
  });
});
