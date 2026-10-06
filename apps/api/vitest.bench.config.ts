import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Timing runs for the article body endpoint: `bunx vitest run -c vitest.bench.config.ts`.
// Kept out of the default suite because wall times vary by machine.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(new URL("./migrations", import.meta.url).pathname),
        },
      },
    })),
  ],
  test: {
    include: ["test/bench/**/*.bench-test.ts"],
    testTimeout: 120_000,
  },
});
