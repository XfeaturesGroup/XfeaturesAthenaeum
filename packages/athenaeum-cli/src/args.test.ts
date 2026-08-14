import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFlags } from "./args.js";

test("separates positional args from --flag value pairs", () => {
  const result = parseFlags(["search", "refund", "policy", "--domain", "support", "--limit", "5"]);
  assert.deepEqual(result.positional, ["search", "refund", "policy"]);
  assert.deepEqual(result.flags, { domain: "support", limit: "5" });
});

test("a --flag immediately followed by another --flag is boolean true", () => {
  const result = parseFlags(["get-document", "doc-1", "--content", "--verbose"]);
  assert.deepEqual(result.positional, ["get-document", "doc-1"]);
  assert.deepEqual(result.flags, { content: true, verbose: true });
});

test("a trailing --flag with nothing after it is boolean true", () => {
  const result = parseFlags(["--content"]);
  assert.deepEqual(result.flags, { content: true });
});

test("empty input yields empty positional and flags", () => {
  const result = parseFlags([]);
  assert.deepEqual(result.positional, []);
  assert.deepEqual(result.flags, {});
});
