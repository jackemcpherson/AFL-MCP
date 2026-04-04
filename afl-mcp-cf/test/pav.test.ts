import { describe, expect, it } from "vitest"
import { calculateAllPav, calculatePav, MIN_PAV_YEAR, recalculatePav } from "../src/sync/pav"

describe("PAV module", () => {
  it("exports MIN_PAV_YEAR as 1998", () => {
    expect(MIN_PAV_YEAR).toBe(1998)
  })

  it("exports calculatePav as a function", () => {
    expect(typeof calculatePav).toBe("function")
  })

  it("exports recalculatePav as a function", () => {
    expect(typeof recalculatePav).toBe("function")
  })

  it("exports calculateAllPav as a function", () => {
    expect(typeof calculateAllPav).toBe("function")
  })

  it("rejects years before 1998", async () => {
    const fakeEnv = { DB: {} } as never
    await expect(calculatePav(fakeEnv, 1997)).rejects.toThrow(
      "PAV requires inside 50s data",
    )
  })
})
