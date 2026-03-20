# AFL-MCP Development Guide

## AFL Season Structure

The AFL season includes special rounds that don't follow the standard numeric
round numbering. When working with match data, always account for:

- **Opening Round**: Played before Round 1 (typically 4-5 games). In the AFL API
  data this appears as `round.name = "Opening Round"` with `round.roundNumber = 0`.
  The 2026 season Opening Round had 5 games.
- Numbered rounds (Round 1, Round 2, etc.) follow after Opening Round.
- Finals series rounds appear at the end of the season.

When implementing freshness checks, ETL logic, or match queries, never filter or
group by round name/number alone — always use date-based or total match count
comparisons to avoid accidentally excluding Opening Round or other non-standard
rounds.
