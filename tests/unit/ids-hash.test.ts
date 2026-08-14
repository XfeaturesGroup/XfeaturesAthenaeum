import { describe, expect, it } from "vitest";
import { generateId, generateRequestId, generateSecret } from "../../src/utils/ids";
import { hashContent, hashRpcKey, timingSafeEqual } from "../../src/utils/hash";

describe("generateId", () => {
  it("produces a 26-character ULID-shaped id", () => {
    const id = generateId();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("does not repeat across many calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId()));
    expect(ids.size).toBe(500);
  });

  it("is lexically sortable by creation time", async () => {
    const first = generateId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = generateId();
    expect(first < second).toBe(true);
  });
});

describe("generateRequestId / generateSecret", () => {
  it("generateRequestId returns a UUID", () => {
    expect(generateRequestId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generateSecret returns hex of the requested byte length and is not predictable/repeating", () => {
    const a = generateSecret(32);
    const b = generateSecret(32);
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });
});

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

describe("hashContent / hashRpcKey / timingSafeEqual", () => {
  it("hashContent is deterministic for identical bytes", async () => {
    const bytes = toArrayBuffer("hello world");
    const first = await hashContent(bytes);
    const second = await hashContent(bytes);
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it("hashContent differs for different bytes", async () => {
    const a = await hashContent(toArrayBuffer("a"));
    const b = await hashContent(toArrayBuffer("b"));
    expect(a).not.toBe(b);
  });

  it("hashRpcKey depends on the pepper -- same key, different pepper, different hash", async () => {
    const a = await hashRpcKey("my-secret-key", "pepper-a");
    const b = await hashRpcKey("my-secret-key", "pepper-b");
    expect(a).not.toBe(b);
  });

  it("timingSafeEqual matches identical strings and rejects different ones", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    expect(timingSafeEqual("short", "muchlonger")).toBe(false);
  });
});
