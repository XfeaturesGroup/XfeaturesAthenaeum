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
    exclude: [...configDefaults.exclude],
    // Each test file gets its own workerd instance. Letting vitest scale that
    // to the core count starts more of them at once than the pool reliably
    // brings up: on a many-core machine some fail with ECONNRESET during
    // startup, and those files never run. That is loud rather than silent --
    // vitest counts them as unhandled errors and exits non-zero -- but a build
    // that fails for a reason unrelated to the code under test is still a
    // broken build. Four keeps the wall-clock cost of the full suite roughly
    // where unbounded parallelism had it, without the startup contention.
    maxWorkers: 4
  }
});
