import { describe, expect, it } from "vitest";
import { HARD_MINIMUM_DEFAULT_CLASSIFICATION, isClassification, resolveDefaultClassification } from "../../src/security/classification";

describe("isClassification", () => {
  it("accepts the four defined tiers", () => {
    expect(isClassification("PUBLIC")).toBe(true);
    expect(isClassification("INTERNAL")).toBe(true);
    expect(isClassification("CONFIDENTIAL")).toBe(true);
    expect(isClassification("RESTRICTED")).toBe(true);
  });

  it("rejects anything else, including lowercase and near-misses", () => {
    expect(isClassification("public")).toBe(false);
    expect(isClassification("SECRET")).toBe(false);
    expect(isClassification(undefined)).toBe(false);
    expect(isClassification(null)).toBe(false);
    expect(isClassification(123)).toBe(false);
  });
});

// Default classification must never resolve to PUBLIC.
describe("resolveDefaultClassification", () => {
  it("falls back to INTERNAL when unset", () => {
    expect(resolveDefaultClassification(undefined)).toBe(HARD_MINIMUM_DEFAULT_CLASSIFICATION);
    expect(HARD_MINIMUM_DEFAULT_CLASSIFICATION).toBe("INTERNAL");
  });

  it("respects a stricter configured default", () => {
    expect(resolveDefaultClassification("CONFIDENTIAL")).toBe("CONFIDENTIAL");
    expect(resolveDefaultClassification("RESTRICTED")).toBe("RESTRICTED");
  });

  it("refuses to honor PUBLIC as a configured default", () => {
    expect(resolveDefaultClassification("PUBLIC")).toBe("INTERNAL");
  });

  it("falls back to INTERNAL for a garbage value", () => {
    expect(resolveDefaultClassification("not-a-real-tier")).toBe("INTERNAL");
  });
});
