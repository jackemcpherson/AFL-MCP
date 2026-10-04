import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { sync } from "../../src/sync/sync";

it("reports finalization lease expiry, retains the marker and releases the lease", async () => {
  const DB = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("SET in_progress = 0")) return statement;
          const wrap = (prepared: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(prepared, {
              get(inner, key) {
                if (key === "bind") return (...values: unknown[]) => wrap(inner.bind(...values));
                if (key === "run")
                  return async () => {
                    await target
                      .prepare("UPDATE sync_lease SET acquired_at=datetime('now','-11 minutes')")
                      .run();
                    return inner.run();
                  };
                const value = Reflect.get(inner, key);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          return wrap(statement);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(sync({ ...env, DB }, [], { season: 2026, skipShouldRunNow: true })).rejects.toThrow(
    "lease lost",
  );
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(1);
  expect(await env.DB.prepare("SELECT holder FROM sync_lease").first("holder")).toBeNull();
});

it("drains fixture PAV changes on a nonhour tick before clearing the marker", async () => {
  await env.DB.prepare(
    "INSERT INTO seasons(id,competition_id,year,season_key) VALUES(1,1,2026,'2026')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO pav_rebuild_queue(season_id,reason) VALUES(1,'statistics')",
  ).run();
  const now = new Date();
  now.setUTCMinutes(5);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  try {
    await sync(env, [], { skipShouldRunNow: true });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM pav_rebuild_queue").first("n")).toBe(0);
    expect(
      await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
    ).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
