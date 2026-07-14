/**
 * Canonical team-name aliases applied during ingest by `normaliseTeam`.
 *
 * NOT deletable despite fitzroy canonicalising upstream since 2.2.0
 * (re-verified against 3.4.0's `normaliseTeamName` for issue #107):
 * fitzroy's canonical set differs from this database's canonical names
 * for five clubs — fitzroy emits "Adelaide Crows", "Geelong Cats",
 * "Gold Coast Suns", "Sydney Swans", and "West Coast Eagles", while the
 * `teams` table stores "Adelaide", "Geelong", "Gold Coast", "Sydney",
 * and "West Coast". Those entries do live work on every sync; removing
 * them would split each club into a novel ghost team.
 *
 * Kept global (not per-competition) on purpose. Remaining entries:
 *
 * 1. AFL Men's historical renames and casing/punctuation variants
 *    (Brisbane Bears → Brisbane Lions, Footscray → Western Bulldogs,
 *    etc.). Redundant for fitzroy-sourced data (fitzroy folds these
 *    aliases into its canonical names before we see them) but retained
 *    for non-fitzroy inputs and as regression guards.
 *
 * 2. Sir Doug Nicholls Round indigenous club names. From fitzroy 2.2.0
 *    onward these are canonicalised upstream, so the entries here are
 *    belt-and-braces against fitzroy regressions or new SDNR aliases the
 *    AFL API starts returning before fitzroy ships support. Without them,
 *    a novel SDNR name silently breaks the sync (see issue #78 / 0009 mig).
 */
export const TEAM_NAME_MAP: Record<string, string> = {
  // AFLM historical renames + capitalisation/punctuation variants
  "Greater Western Sydney": "GWS Giants",
  GWS: "GWS Giants",
  "GWS GIANTS": "GWS Giants",
  "Brisbane Bears": "Brisbane Lions",
  Brisbane: "Brisbane Lions",
  Footscray: "Western Bulldogs",
  "Sydney Swans": "Sydney",
  "Geelong Cats": "Geelong",
  "Adelaide Crows": "Adelaide",
  "West Coast Eagles": "West Coast",
  "Gold Coast SUNS": "Gold Coast",
  "Gold Coast Suns": "Gold Coast",
  // Sir Doug Nicholls Round indigenous names (belt-and-braces; fitzroy
  // 2.2.0+ canonicalises upstream). Add new SDNR aliases here if they
  // emerge before fitzroy ships support.
  Kuwarna: "Adelaide",
  Walyalup: "Fremantle",
  Narrm: "Melbourne",
  Yartapuulti: "Port Adelaide",
  "Euro-Yroke": "St Kilda",
  "Waalitj Marawar": "West Coast",
};

export const VENUE_NAME_MAP: Record<string, string> = {
  "M.C.G.": "MCG",
  "S.C.G.": "SCG",
  Docklands: "Marvel Stadium",
  "Etihad Stadium": "Marvel Stadium",
  "GMHBA Stadium": "Kardinia Park",
  "Manuka Oval": "Manuka Oval",
  "Corroboree Group Oval Manuka": "Manuka Oval",
  "Blundstone Arena": "Blundstone Arena",
  "Bellerive Oval": "Blundstone Arena",
  "Sydney Showground": "Sydney Showground",
  "ENGIE Stadium": "Sydney Showground",
  "GIANTS Stadium": "Sydney Showground",
  "Stadium Australia": "Accor Stadium",
  "ANZ Stadium": "Accor Stadium",
  "Cazaly's Stadium": "Cazalys Stadium",
  "TIO Stadium": "TIO Stadium",
  "Marrara Oval": "TIO Stadium",
  "TIO Traeger Park": "Traeger Park",
  "Ikon Park": "Princes Park",
  "Mars Stadium": "Mars Stadium",
  "Eureka Stadium": "Mars Stadium",
  "People First Stadium": "Carrara",
  "Heritage Bank Stadium": "Carrara",
  Carrara: "Carrara",
  "Metricon Stadium": "Carrara",
  "Perth Stadium": "Perth Stadium",
  "Optus Stadium": "Perth Stadium",
  Gabba: "Gabba",
  "The Gabba": "Gabba",
  "York Park": "UTAS Stadium",
  "UTAS Stadium": "UTAS Stadium",
  "University of Tasmania Stadium": "UTAS Stadium",
  "Jiangwan Stadium": "Jiangwan Stadium",
  "Traeger Park": "Traeger Park",
  "Riverway Stadium": "Riverway Stadium",
  "Norwood Oval": "Norwood Oval",
};

/**
 * Earliest season for which PAV can be computed, per competition.
 *
 * AFLM: 1998 — when Champion Data began tracking inside 50s, the league-
 * normalising input the PAV formula leans on most heavily.
 * AFLW: 2017 — the inaugural AFLW season; AFL API populates the full
 * PAV input set from the start.
 *
 * VFL and VFLW are intentionally absent: the AFL API does not populate
 * `goalAssists`, `marksInside50`, or `onePercenters` for those
 * competitions, so the canonical PAV formula cannot be applied.
 */
export const MIN_PAV_YEAR_BY_COMPETITION = {
  AFLM: 1998,
  AFLW: 2017,
} as const;
