import { describe, expect, it } from "vitest";
import { isPlaceholderTeamName, normaliseTeam, normaliseVenue } from "../src/lib/normalise";

describe("normaliseTeam", () => {
  it("maps known aliases to canonical names", () => {
    expect(normaliseTeam("Greater Western Sydney")).toBe("GWS Giants");
    expect(normaliseTeam("GWS")).toBe("GWS Giants");
    expect(normaliseTeam("Brisbane Bears")).toBe("Brisbane Lions");
    expect(normaliseTeam("Footscray")).toBe("Western Bulldogs");
    expect(normaliseTeam("Sydney Swans")).toBe("Sydney");
    expect(normaliseTeam("Geelong Cats")).toBe("Geelong");
  });

  it("returns canonical names unchanged", () => {
    expect(normaliseTeam("Melbourne")).toBe("Melbourne");
    expect(normaliseTeam("Collingwood")).toBe("Collingwood");
    expect(normaliseTeam("GWS Giants")).toBe("GWS Giants");
  });

  it("trims whitespace", () => {
    expect(normaliseTeam("  GWS  ")).toBe("GWS Giants");
    expect(normaliseTeam(" Melbourne ")).toBe("Melbourne");
  });

  it("maps Sir Doug Nicholls Round indigenous names to canonical clubs", () => {
    expect(normaliseTeam("Kuwarna")).toBe("Adelaide");
    expect(normaliseTeam("Walyalup")).toBe("Fremantle");
    expect(normaliseTeam("Narrm")).toBe("Melbourne");
    expect(normaliseTeam("Yartapuulti")).toBe("Port Adelaide");
    expect(normaliseTeam("Euro-Yroke")).toBe("St Kilda");
    expect(normaliseTeam("Waalitj Marawar")).toBe("West Coast");
  });
});

describe("normaliseVenue", () => {
  it("maps known aliases to canonical names", () => {
    expect(normaliseVenue("M.C.G.")).toBe("MCG");
    expect(normaliseVenue("Docklands")).toBe("Marvel Stadium");
    expect(normaliseVenue("Etihad Stadium")).toBe("Marvel Stadium");
    expect(normaliseVenue("The Gabba")).toBe("Gabba");
    expect(normaliseVenue("Optus Stadium")).toBe("Perth Stadium");
    expect(normaliseVenue("ENGIE Stadium")).toBe("Sydney Showground");
    expect(normaliseVenue("GIANTS Stadium")).toBe("Sydney Showground");
  });

  it("returns canonical names unchanged", () => {
    expect(normaliseVenue("MCG")).toBe("MCG");
    expect(normaliseVenue("Gabba")).toBe("Gabba");
  });

  it("trims whitespace", () => {
    expect(normaliseVenue("  M.C.G.  ")).toBe("MCG");
  });
});

describe("isPlaceholderTeamName", () => {
  it("matches ladder-position ordinals", () => {
    expect(isPlaceholderTeamName("1st")).toBe(true);
    expect(isPlaceholderTeamName("2nd")).toBe(true);
    expect(isPlaceholderTeamName("3rd")).toBe(true);
    expect(isPlaceholderTeamName("10th")).toBe(true);
    expect(isPlaceholderTeamName("18th")).toBe(true);
  });

  it("matches finals progression labels", () => {
    expect(isPlaceholderTeamName("Winner of QF1")).toBe(true);
    expect(isPlaceholderTeamName("Winner of PF2")).toBe(true);
    expect(isPlaceholderTeamName("Loser of QF2")).toBe(true);
    expect(isPlaceholderTeamName("Highest-ranked WF Winner")).toBe(true);
    expect(isPlaceholderTeamName("Lowest-ranked WF Winner")).toBe(true);
  });

  it("matches bare TBC/TBA markers", () => {
    expect(isPlaceholderTeamName("TBC")).toBe(true);
    expect(isPlaceholderTeamName("TBA")).toBe(true);
    expect(isPlaceholderTeamName("To Be Confirmed")).toBe(true);
  });

  it("does not match real club names", () => {
    expect(isPlaceholderTeamName("Carlton")).toBe(false);
    expect(isPlaceholderTeamName("GWS Giants")).toBe(false);
    expect(isPlaceholderTeamName("Western Bulldogs")).toBe(false);
    expect(isPlaceholderTeamName("Kuwarna")).toBe(false);
    // Hypothetical future clubs must not be swallowed by the guard.
    expect(isPlaceholderTeamName("Tasmania Devils")).toBe(false);
    // Contains a progression word but is not a progression label.
    expect(isPlaceholderTeamName("Winners Circle FC")).toBe(false);
  });
});
