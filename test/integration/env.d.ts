import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../../src/types";

declare global {
  namespace Cloudflare {
    /** The miniflare test env carries the app bindings plus migrations. */
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
