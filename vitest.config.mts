import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "src/db/migrations"));

  const contractMigrations = migrations.filter((entry) => entry.name.startsWith("0040"));
  const expansionMigrations = migrations.filter((entry) => !entry.name.startsWith("0040"));

  const legacyMigrations = await readD1Migrations(
    path.resolve(import.meta.dirname, "test/fixtures/legacy-migrations"),
  );

  return {
    test: {
      projects: [
        {
          test: {
            name: "unit",
            include: ["test/*.test.ts", "test/*.test.mjs"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              miniflare: {
                compatibilityDate: "2026-04-01",
                compatibilityFlags: ["nodejs_compat"],
                d1Databases: ["DB", "UPGRADE_DB", "GUARD_DB", "FRESH_DB", "CONTRACT_DB"],
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  TEST_CONTRACT_MIGRATIONS: contractMigrations,
                  TEST_EXPANSION_MIGRATIONS: expansionMigrations,
                  TEST_LEGACY_MIGRATIONS: legacyMigrations,
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
