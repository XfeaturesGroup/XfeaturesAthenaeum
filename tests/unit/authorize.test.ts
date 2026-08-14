import { describe, expect, it } from "vitest";
import { authorize } from "../../src/auth/authorize";
import type { Principal } from "../../src/auth/types";

function principal(permissions: string[]): Principal {
  return { agentId: "agent_test", agentKey: "test-agent", environment: "development", permissions: new Set(permissions) };
}

// Mirrors the seed roles in seed/dev-seed.sql so this test doubles as a
// regression check on the actual default permission sets, not just the
// authorize() engine in isolation.
const PUBLIC_AGENT = principal(["knowledge.search", "knowledge.classification.PUBLIC", "documents.read.public", "facts.read.products"]);

const SUPPORT_AGENT = principal([
  "knowledge.search",
  "knowledge.classification.PUBLIC",
  "knowledge.classification.INTERNAL",
  "documents.read.public",
  "documents.read.support",
  "facts.read.products",
  "facts.read.plans",
  "facts.read.policies"
]);

const NETWORK_AGENT = principal([
  "knowledge.search",
  "knowledge.classification.PUBLIC",
  "knowledge.classification.INTERNAL",
  "knowledge.classification.CONFIDENTIAL",
  "documents.read.public",
  "documents.read.network",
  "documents.read.infrastructure",
  "network.read",
  "network.restricted.read"
]);

// The required authorization test matrix.
describe("authorization test matrix", () => {
  it("public agent -> PUBLIC document -> ALLOW", () => {
    const result = authorize(PUBLIC_AGENT, { action: "documents.read", resource: { domain: "public", classification: "PUBLIC" } });
    expect(result.allowed).toBe(true);
  });

  it("public agent -> INTERNAL document -> DENY", () => {
    const result = authorize(PUBLIC_AGENT, { action: "documents.read", resource: { domain: "public", classification: "INTERNAL" } });
    expect(result.allowed).toBe(false);
  });

  it("public agent -> CONFIDENTIAL document -> DENY", () => {
    const result = authorize(PUBLIC_AGENT, { action: "documents.read", resource: { domain: "public", classification: "CONFIDENTIAL" } });
    expect(result.allowed).toBe(false);
  });

  it("public agent -> RESTRICTED document -> DENY", () => {
    const result = authorize(PUBLIC_AGENT, { action: "documents.read", resource: { domain: "public", classification: "RESTRICTED" } });
    expect(result.allowed).toBe(false);
  });

  it("support agent -> PUBLIC document -> ALLOW", () => {
    const result = authorize(SUPPORT_AGENT, { action: "documents.read", resource: { domain: "public", classification: "PUBLIC" } });
    expect(result.allowed).toBe(true);
  });

  it("support agent -> support-domain INTERNAL document -> ALLOW", () => {
    const result = authorize(SUPPORT_AGENT, { action: "documents.read", resource: { domain: "support", classification: "INTERNAL" } });
    expect(result.allowed).toBe(true);
  });

  it("support agent -> restricted network document -> DENY (no domain scope)", () => {
    const result = authorize(SUPPORT_AGENT, { action: "documents.read", resource: { domain: "network", classification: "RESTRICTED" } });
    expect(result.allowed).toBe(false);
  });

  it("support agent -> network domain even at a classification it holds -> DENY (never had network domain scope)", () => {
    const result = authorize(SUPPORT_AGENT, { action: "documents.read", resource: { domain: "network", classification: "INTERNAL" } });
    expect(result.allowed).toBe(false);
  });

  it("network agent -> permitted network document -> ALLOW", () => {
    const result = authorize(NETWORK_AGENT, { action: "documents.read", resource: { domain: "network", classification: "CONFIDENTIAL" } });
    expect(result.allowed).toBe(true);
  });

  it("network agent -> RESTRICTED network document -> DENY (holds CONFIDENTIAL ceiling, not RESTRICTED)", () => {
    const result = authorize(NETWORK_AGENT, { action: "documents.read", resource: { domain: "network", classification: "RESTRICTED" } });
    expect(result.allowed).toBe(false);
  });

  it("an agent with zero permissions is denied every action (default deny)", () => {
    const empty = principal([]);
    expect(authorize(empty, { action: "knowledge.search" }).allowed).toBe(false);
    expect(authorize(empty, { action: "documents.read", resource: { domain: "public", classification: "PUBLIC" } }).allowed).toBe(false);
    expect(authorize(empty, { action: "admin.agents" }).allowed).toBe(false);
  });
});

describe("authorize: facts.read requires both scope and classification permission", () => {
  it("allows when both are present", () => {
    const result = authorize(SUPPORT_AGENT, { action: "facts.read", resource: { namespace: "plans", classification: "INTERNAL" } });
    expect(result.allowed).toBe(true);
  });

  it("denies when the namespace scope is missing, even with the classification permission", () => {
    const result = authorize(SUPPORT_AGENT, { action: "facts.read", resource: { namespace: "services", classification: "INTERNAL" } });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("MISSING_SCOPE_PERMISSION");
  });

  it("denies when the classification is missing, even with the namespace scope", () => {
    const result = authorize(SUPPORT_AGENT, { action: "facts.read", resource: { namespace: "plans", classification: "RESTRICTED" } });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("CLASSIFICATION_NOT_PERMITTED");
  });
});

describe("authorize: admin/global actions", () => {
  it("denies admin.agents without the exact permission", () => {
    expect(authorize(SUPPORT_AGENT, { action: "admin.agents" }).allowed).toBe(false);
  });

  it("allows admin.agents when explicitly granted", () => {
    const admin = principal(["admin.agents"]);
    expect(authorize(admin, { action: "admin.agents" }).allowed).toBe(true);
  });
});
