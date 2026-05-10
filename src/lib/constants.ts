/**
 * Canonical team-name aliases applied during ingest by `normaliseTeam`.
 *
 * Kept global (not per-competition) on purpose: the entries here are AFL
 * Men's historical renames (Brisbane Bears → Brisbane Lions, Footscray →
 * Western Bulldogs, etc.) plus a few capitalisation/punctuation variants.
 * Fitzroy v2.1 returns canonical names for AFLW/VFL/VFLW (verified at the
 * AFL API level for 2017+ AFLW and 2021+ VFL/VFLW), so applying this map
 * to those competitions is a no-op for fitzroy-sourced data.
 */
export const TEAM_NAME_MAP: Record<string, string> = {
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
