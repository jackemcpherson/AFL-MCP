import { TEAM_NAME_MAP, VENUE_NAME_MAP } from "./constants"

export function normaliseTeam(name: string): string {
  const trimmed = name.trim()
  return TEAM_NAME_MAP[trimmed] ?? trimmed
}

export function normaliseVenue(name: string): string {
  const trimmed = name.trim()
  return VENUE_NAME_MAP[trimmed] ?? trimmed
}
