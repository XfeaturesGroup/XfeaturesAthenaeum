import { describe, expect, it } from "vitest";
import { BRANDING } from "../../src/branding";

// Source is inlined at build time: tests run inside workerd, which has no filesystem.
import PACKAGE_JSON from "../../package.json?raw";
import OPENAPI_SOURCE from "../../docs/openapi.yaml?raw";

/**
 * One release, one version number.
 *
 * `BRANDING.VERSION` is not decoration: it is what the MCP server reports in
 * `initialize`, so every connecting client sees it. It drifted from
 * package.json once already -- the Worker advertised 0.2.0 while the package
 * claimed 0.1.0 and the OpenAPI document claimed 1.0.0 -- and nothing failed,
 * because nothing was comparing them.
 *
 * The `/v1` path prefix is a separate thing: that is the API's major version,
 * and it deliberately does not track the release version.
 */
describe("the version is the same everywhere it is published", () => {
  const packageVersion = (JSON.parse(PACKAGE_JSON) as { version: string }).version;

  it("package.json carries a plain semantic version", () => {
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the version the MCP server advertises matches package.json", () => {
    expect(BRANDING.VERSION).toBe(packageVersion);
  });

  it("the OpenAPI document's info.version matches package.json", () => {
    const match = /^info:\n(?:.*\n)*?  version: "([^"]+)"/m.exec(OPENAPI_SOURCE);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(packageVersion);
  });
});
