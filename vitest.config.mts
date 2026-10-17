import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig, type ViteUserConfigFnPromise } from "vitest/config";

const config: ViteUserConfigFnPromise = defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(import.meta.dirname, "src/db/migrations"));

  const contractMigrations = migrations.filter((entry) => entry.name.startsWith("0040"));
  const expansionMigrations = migrations.filter((entry) => !entry.name.startsWith("0040"));

  const legacyMigrations = await readD1Migrations(
    path.resolve(import.meta.dirname, "test/fixtures/legacy-migrations"),
  );

  // CI must fail on a missing golden instead of writing it. This covers
  // `toMatchFileSnapshot`. Vitest already does this when it detects CI.
  // The explicit setting keeps it from depending on that detection.
  const ci = process.env["CI"];
  const update: "none" | false = ci !== undefined && ci !== "" && ci !== "false" ? "none" : false;

  return {
    test: {
      update,
      projects: [
        {
          test: {
            name: "unit",
            include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
            exclude: [...configDefaults.exclude, "**/*.worker.test.ts"],
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
            // Workers-pool isolates share the CPU when every file runs at once,
            // so a D1-heavy test can pass 5 s on a loaded machine. 15 s keeps
            // full parallelism and still catches a hung test.
            testTimeout: 15_000,
            include: ["test/**/*.worker.test.ts"],
            setupFiles: ["test/support/worker-setup.ts"],
          },
        },
      ],
    },
  };
});

export default config;
