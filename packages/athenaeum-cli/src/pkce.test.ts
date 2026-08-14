import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

test("generateCodeVerifier produces a base64url string with no padding", () => {
  const verifier = generateCodeVerifier();
  assert.match(verifier, BASE64URL);
  assert.ok(verifier.length >= 43, "RFC 7636 requires at least 43 characters");
});

test("generateCodeChallenge is the base64url(sha256(verifier)), matching Account's own verification", () => {
  const verifier = "fixed-test-verifier-value";
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(generateCodeChallenge(verifier), expected);
});

test("two calls never produce the same verifier or state (not a fixed/reused value)", () => {
  assert.notEqual(generateCodeVerifier(), generateCodeVerifier());
  assert.notEqual(generateState(), generateState());
});

test("generateState is base64url too (safe to place directly in a URL query string)", () => {
  assert.match(generateState(), BASE64URL);
});
