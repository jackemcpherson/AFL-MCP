import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "src/db/migrations"));

  return {
    test: {
      projects: [
        {
          test: {
            name: "unit",
            include: ["test/*.test.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              miniflare: {
                compatibilityDate: "2026-04-01",
                compatibilityFlags: ["nodejs_compat"],
                d1Databases: ["DB"],
                bindings: {
                  TEST_MIGRATIONS: migrations,
                },
              },
              wrangler: { configPath: "./wrangler.toml" },
            }),
          ],
          test: {
            name: "integration",
            include: ["test/integration/**/*.test.ts"],
            setupFiles: ["test/integration/_setup.ts"],
          },
        },
      ],
    },
  };
});
