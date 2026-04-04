import { describe, expect, it } from "vitest"
import { calculatePav } from "../src/sync/pav"

describe("calculatePav", () => {
  it("rejects years before 1998", async () => {
    const fakeEnv = { DB: {} } as never
    await expect(calculatePav(fakeEnv, 1997)).rejects.toThrow(
      "PAV requires inside 50s data",
    )
  })

  it("rejects the boundary year 1997 but accepts 1998", async () => {
    const fakeEnv = { DB: {} } as never
    await expect(calculatePav(fakeEnv, 1997)).rejects.toThrow()
    // 1998 should proceed past the guard and attempt DB access
    await expect(calculatePav(fakeEnv, 1998)).rejects.not.toThrow(
      "PAV requires inside 50s data",
    )
  })
})
