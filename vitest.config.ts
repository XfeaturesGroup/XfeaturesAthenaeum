import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" }
    })
  ],
  test: {
    globals: true,
    // Standalone npm packages (@xfeatures/athenaeum-{types,sdk,cli}) use
    // node:test, not vitest, and are not part of the Worker's test project --
    // exclude them (source and compiled dist output alike) so they are not
    // picked up by vitest's default file discovery.
    exclude: [...configDefaults.exclude, "packages/**"]
  }
});
