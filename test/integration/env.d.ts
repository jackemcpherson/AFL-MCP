import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../../src/types";

declare global {
  namespace Cloudflare {
    /** The miniflare test env carries the app bindings plus migrations. */
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_CONTRACT_MIGRATIONS: D1Migration[];
      TEST_EXPANSION_MIGRATIONS: D1Migration[];
      CONTRACT_DB: D1Database;
      TEST_LEGACY_MIGRATIONS: D1Migration[];
      UPGRADE_DB: D1Database;
      GUARD_DB: D1Database;
      FRESH_DB: D1Database;
    }
  }
}
