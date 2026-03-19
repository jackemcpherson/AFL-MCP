"""High-level AFL statistics tools built on top of execute_query.

Provides the ladder computation and team alias resolution used by
both the MCP server and semantic search modules.
"""

from __future__ import annotations

from afl_mcp.core.queries import execute_query

__all__ = ["get_ladder", "TEAM_ALIAS_MAP"]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TEAM_ALIAS_MAP: dict[str, str] = {
    "bulldogs": "Western Bulldogs",
    "dogs": "Western Bulldogs",
    "footscray": "Western Bulldogs",
    "pies": "Collingwood",
    "magpies": "Collingwood",
    "dons": "Essendon",
    "bombers": "Essendon",
    "cats": "Geelong",
    "blues": "Carlton",
    "hawks": "Hawthorn",
    "demons": "Melbourne",
    "dees": "Melbourne",
    "saints": "St Kilda",
    "roos": "North Melbourne",
    "kangaroos": "North Melbourne",
    "crows": "Adelaide",
    "dockers": "Fremantle",
    "freo": "Fremantle",
    "eagles": "West Coast",
    "swans": "Sydney",
    "suns": "Gold Coast",
    "giants": "GWS Giants",
    "gws": "GWS Giants",
    "lions": "Brisbane Lions",
    "brisbane": "Brisbane Lions",
    "tigers": "Richmond",
    "power": "Port Adelaide",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_team_name(name: str) -> str:
    """Resolve a team alias to its canonical name.

    Checks TEAM_ALIAS_MAP (case-insensitive). Returns the input unchanged
    if no alias matches.
    """
    return TEAM_ALIAS_MAP.get(name.lower().strip(), name.strip())


# ---------------------------------------------------------------------------
# get_ladder
# ---------------------------------------------------------------------------


def get_ladder(year: int, round_number: int | None = None) -> list[dict]:
    """Compute the AFL ladder for a given season.

    Args:
        year: Season year.
        round_number: If provided, ladder as at end of that round.
            If omitted, full regular season.

    Returns:
        List of dicts ordered by ladder position with position, team,
        played, wins, losses, draws, points_for, points_against,
        percentage, premiership_points.
    """
    # Build WHERE clause from hardcoded conditions only — no user input
    # is interpolated into the SQL string.
    round_filter = " AND m.round_number <= %s" if round_number is not None else ""
    base_params: list = [year]
    if round_number is not None:
        base_params.append(round_number)
    # Parameters are duplicated for the two UNION ALL halves.
    all_params = base_params + base_params

    sql = f"""WITH team_results AS (
            SELECT
                m.home_team_id AS team_id,
                m.home_points AS points_for,
                m.away_points AS points_against,
                CASE WHEN m.margin > 0 THEN 1 ELSE 0 END AS wins,
                CASE WHEN m.margin < 0 THEN 1 ELSE 0 END AS losses,
                CASE WHEN m.margin = 0 THEN 1 ELSE 0 END AS draws
            FROM matches m
            JOIN seasons s ON s.id = m.season_id
            WHERE s.year = %s AND m.round_type = 'Regular'{round_filter}
            UNION ALL
            SELECT
                m.away_team_id AS team_id,
                m.away_points AS points_for,
                m.home_points AS points_against,
                CASE WHEN m.margin < 0 THEN 1 ELSE 0 END AS wins,
                CASE WHEN m.margin > 0 THEN 1 ELSE 0 END AS losses,
                CASE WHEN m.margin = 0 THEN 1 ELSE 0 END AS draws
            FROM matches m
            JOIN seasons s ON s.id = m.season_id
            WHERE s.year = %s AND m.round_type = 'Regular'{round_filter}
        ),
        ladder AS (
            SELECT
                t.name AS team,
                COUNT(*) AS played,
                SUM(tr.wins)::int AS wins,
                SUM(tr.losses)::int AS losses,
                SUM(tr.draws)::int AS draws,
                SUM(tr.points_for)::int AS points_for,
                SUM(tr.points_against)::int AS points_against,
                ROUND(
                    SUM(tr.points_for)::numeric
                    / NULLIF(SUM(tr.points_against), 0) * 100, 1
                ) AS percentage,
                (SUM(tr.wins) * 4 + SUM(tr.draws) * 2)::int
                    AS premiership_points
            FROM team_results tr
            JOIN teams t ON t.id = tr.team_id
            GROUP BY t.id, t.name
        )
        SELECT
            ROW_NUMBER() OVER (
                ORDER BY premiership_points DESC, percentage DESC
            )::int AS position,
            team, played, wins, losses, draws,
            points_for, points_against, percentage,
            premiership_points
        FROM ladder
        ORDER BY position"""

    return execute_query(sql, all_params)
