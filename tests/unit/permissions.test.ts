import { describe, expect, it } from "vitest";
import { hasAllPermissions, hasAnyPermission, hasPermission, permissionSatisfies } from "../../src/auth/permissions";

describe("permissionSatisfies", () => {
  it("matches an exact permission", () => {
    expect(permissionSatisfies("documents.read.support", "documents.read.support")).toBe(true);
  });

  it("does not match a different exact permission", () => {
    expect(permissionSatisfies("documents.read.support", "documents.read.billing")).toBe(false);
  });

  it("matches a suffix wildcard against any child", () => {
    expect(permissionSatisfies("documents.read.*", "documents.read.support")).toBe(true);
    expect(permissionSatisfies("documents.read.*", "documents.read.restricted-network")).toBe(true);
  });

  it("does not let a wildcard match a sibling namespace", () => {
    expect(permissionSatisfies("documents.read.*", "facts.read.support")).toBe(false);
  });

  it("does not let a wildcard match itself with nothing after the dot", () => {
    expect(permissionSatisfies("documents.read.*", "documents.read.")).toBe(false);
    expect(permissionSatisfies("documents.read.*", "documents.read")).toBe(false);
  });

  it("does not treat a bare '*' as a match for anything (no bare wildcard support)", () => {
    expect(permissionSatisfies("*", "documents.read.support")).toBe(false);
    expect(permissionSatisfies("*", "admin.agents")).toBe(false);
  });

  it("does not treat mid-string '*' as a wildcard", () => {
    expect(permissionSatisfies("documents.*.public", "documents.read.public")).toBe(false);
  });

  it("rejects empty strings on either side", () => {
    expect(permissionSatisfies("", "documents.read.support")).toBe(false);
    expect(permissionSatisfies("documents.read.support", "")).toBe(false);
  });
});

describe("hasPermission / hasAnyPermission / hasAllPermissions", () => {
  const granted = new Set(["knowledge.search", "documents.read.*", "facts.read.products"]);

  it("hasPermission finds an exact grant", () => {
    expect(hasPermission(granted, "knowledge.search")).toBe(true);
  });

  it("hasPermission finds a grant via wildcard", () => {
    expect(hasPermission(granted, "documents.read.billing")).toBe(true);
  });

  it("hasPermission returns false for an ungranted permission", () => {
    expect(hasPermission(granted, "admin.agents")).toBe(false);
  });

  it("hasPermission on an empty set always denies (default deny)", () => {
    expect(hasPermission(new Set(), "knowledge.search")).toBe(false);
  });

  it("hasAnyPermission is true if at least one required permission is granted", () => {
    expect(hasAnyPermission(granted, ["admin.agents", "knowledge.search"])).toBe(true);
  });

  it("hasAnyPermission is false if none are granted", () => {
    expect(hasAnyPermission(granted, ["admin.agents", "admin.roles"])).toBe(false);
  });

  it("hasAllPermissions requires every permission to be granted", () => {
    expect(hasAllPermissions(granted, ["knowledge.search", "documents.read.support"])).toBe(true);
    expect(hasAllPermissions(granted, ["knowledge.search", "admin.agents"])).toBe(false);
  });
});
