import { describe, expect, it } from "vitest";
import { mergeIdentityAppearances } from "../src/admin/player-identities";

const evidence = {
  url: "https://www.afl.com.au/stats",
  sha256: "a".repeat(64),
  explanation: "Captured authoritative provider field value",
};
const rows = [
  { id: 8, player_id: 712, match_id: 1, kicks: 7, marks: null, handballs: 3 },
  { id: 9, player_id: 10974, match_id: 1, kicks: 7, marks: 2, handballs: 4 },
];
describe("verified identity appearance merging", () => {
  it("retains canonical appearance, fills nulls and blocks conflicting non-null values", () => {
    const result = mergeIdentityAppearances("player_match_stats", rows, 712, []);
    expect(result.rows).toEqual([{ ...rows[0], marks: 2 }]);
    expect(result.conflicts).toEqual([
      { table: "player_match_stats", matchId: 1, field: "handballs", values: [3, 4] },
    ]);
  });
  it("applies recorded field decisions without counting both appearances", () => {
    const result = mergeIdentityAppearances("player_match_stats", rows, 712, [
      { table: "player_match_stats", matchId: 1, field: "handballs", value: 4, evidence },
    ]);
    expect(result.rows).toEqual([{ ...rows[0], marks: 2, handballs: 4 }]);
    expect(result.conflicts).toEqual([]);
    expect(mergeIdentityAppearances("player_match_stats", result.rows, 712, []).rows).toEqual(
      result.rows,
    );
  });
  it("rejects text resolutions for numeric statistics", () => {
    expect(() =>
      mergeIdentityAppearances("player_match_stats", rows, 712, [
        { table: "player_match_stats", matchId: 1, field: "handballs", value: "4", evidence },
      ]),
    ).toThrow("must be number");
  });
  it("rejects decisions that do not address an actual conflict", () => {
    expect(() =>
      mergeIdentityAppearances("player_match_stats", rows, 712, [
        { table: "player_match_stats", matchId: 1, field: "kikcs", value: 8, evidence },
      ]),
    ).toThrow("conflicting field");
  });
});
