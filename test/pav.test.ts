import { describe, expect, it } from "vitest";
import { calculatePav } from "../src/sync/pav";

describe("calculatePav", () => {
  describe("AFLM", () => {
    it("rejects years before 1998", async () => {
      const fakeEnv = { DB: {} } as never;
      await expect(calculatePav(fakeEnv, 1997, "AFLM")).rejects.toThrow(
        /AFLM is supported from 1998/,
      );
    });

    it("rejects the boundary year 1997 but accepts 1998", async () => {
      const fakeEnv = { DB: {} } as never;
      await expect(calculatePav(fakeEnv, 1997, "AFLM")).rejects.toThrow();
      // 1998 should proceed past the guard and attempt DB access
      await expect(calculatePav(fakeEnv, 1998, "AFLM")).rejects.not.toThrow(
        /AFLM is supported from/,
      );
    });
  });

  describe("AFLW", () => {
    it("rejects years before 2017", async () => {
      const fakeEnv = { DB: {} } as never;
      await expect(calculatePav(fakeEnv, 2016, "AFLW")).rejects.toThrow(
        /AFLW is supported from 2017/,
      );
    });

    it("rejects the boundary year 2016 but accepts 2017", async () => {
      const fakeEnv = { DB: {} } as never;
      await expect(calculatePav(fakeEnv, 2016, "AFLW")).rejects.toThrow();
      // 2017 should proceed past the guard and attempt DB access
      await expect(calculatePav(fakeEnv, 2017, "AFLW")).rejects.not.toThrow(
        /AFLW is supported from/,
      );
    });
  });
});
