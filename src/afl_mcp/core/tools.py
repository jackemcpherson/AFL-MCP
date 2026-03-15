"""High-level AFL statistics tools built on top of execute_query.

Provides purpose-built functions for common AFL queries: player search,
ladders, stat leaders, head-to-head records, career summaries, player
comparisons, and match search.
"""

from __future__ import annotations

from afl_mcp.core.queries import execute_query

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VALID_STAT_COLUMNS: frozenset[str] = frozenset(
    {
        "kicks",
        "handballs",
        "disposals",
        "effective_disposals",
        "marks",
        "bounces",
        "tackles",
        "one_percenters",
        "clangers",
        "contested_possessions",
        "uncontested_possessions",
        "goals",
        "behinds",
        "goal_assists",
        "shots_at_goal",
        "score_involvements",
        "score_launches",
        "centre_clearances",
        "stoppage_clearances",
        "clearances",
        "contested_marks",
        "marks_inside_fifty",
        "intercept_marks",
        "marks_on_lead",
        "free_kicks_for",
        "free_kicks_against",
        "hitouts",
        "hitouts_to_advantage",
        "ruck_contests",
        "inside_fifties",
        "rebounds",
        "turnovers",
        "intercepts",
        "metres_gained",
        "pressure_acts",
        "def_half_pressure_acts",
        "tackles_inside_fifty",
        "spoils",
        "contest_def_losses",
        "contest_def_one_on_ones",
        "contest_off_one_on_ones",
        "contest_off_wins",
        "effective_kicks",
        "ground_ball_gets",
        "f50_ground_ball_gets",
        "brownlow_votes",
        "afl_fantasy_score",
        "supercoach_score",
    }
)

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


_PAV_ZONE_COLUMNS: dict[str, str] = {
    "off": "off_pav",
    "mid": "mid_pav",
    "def": "def_pav",
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


def _resolve_player_id(player_id: int | None, player_name: str | None) -> int:
    """Resolve a player ID from either an explicit ID or a name search.

    Args:
        player_id: Player database ID (returned directly if provided).
        player_name: Player name to search for.

    Returns:
        Resolved player ID.

    Raises:
        ValueError: If neither argument is provided or no match found.
    """
    if player_id is None and player_name is None:
        raise ValueError("Provide either player_id or player_name.")
    if player_id is not None:
        return player_id
    results = search_players(player_name, limit=1)  # type: ignore[arg-type]
    if not results:
        raise ValueError(f"No player found matching {player_name!r}.")
    return results[0]["id"]


# ---------------------------------------------------------------------------
# Tool 1: search_players
# ---------------------------------------------------------------------------


def search_players(query: str, limit: int = 10) -> list[dict]:
    """Search for AFL players by name.

    Supports partial first name, surname, or full name matching.

    Args:
        query: Player name to search for (partial or full).
        limit: Maximum results to return.

    Returns:
        List of dicts with id, first_name, surname, current_team.
    """
    tokens = query.strip().split()
    if not tokens:
        return []

    if len(tokens) == 1:
        pattern = f"%{tokens[0]}%"
        where = "p.first_name ILIKE %s OR p.surname ILIKE %s"
        params: list = [pattern, pattern]
    else:
        first_pattern = f"%{tokens[0]}%"
        last_pattern = f"%{' '.join(tokens[1:])}%"
        where = "p.first_name ILIKE %s AND p.surname ILIKE %s"
        params = [first_pattern, last_pattern]

    params.append(limit)

    return execute_query(
        f"""WITH matched AS (
                SELECT p.id, p.first_name, p.surname
                FROM players p
                WHERE {where}
                ORDER BY p.surname, p.first_name
                LIMIT %s
            )
            SELECT m.id, m.first_name, m.surname, t.name AS current_team
            FROM matched m
            LEFT JOIN LATERAL (
                SELECT tm.name
                FROM player_match_stats pms
                JOIN matches mt ON mt.id = pms.match_id
                JOIN teams tm ON tm.id = pms.team_id
                WHERE pms.player_id = m.id
                ORDER BY mt.date DESC
                LIMIT 1
            ) t ON true
            ORDER BY m.surname, m.first_name""",
        params,
    )


# ---------------------------------------------------------------------------
# Tool 2: get_ladder
# ---------------------------------------------------------------------------


def get_ladder(year: int, round_number: int | None = None) -> list[dict]:
    """Compute the AFL ladder for a given season.

    Args:
        year: Season year.
        round_number: If provided, ladder as at end of that round.
            If omitted, full regular season.

    Returns:
        List of dicts ordered by ladder position with team, played,
        wins, losses, draws, points_for, points_against, percentage,
        premiership_points.
    """
    conditions = ["s.year = %s", "m.round_type = 'Regular'"]
    params: list = [year]

    if round_number is not None:
        conditions.append("m.round_number <= %s")
        params.append(round_number)

    where = " AND ".join(conditions)
    all_params = params + params

    return execute_query(
        f"""WITH team_results AS (
                SELECT
                    m.home_team_id AS team_id,
                    m.home_points AS points_for,
                    m.away_points AS points_against,
                    CASE WHEN m.margin > 0 THEN 1 ELSE 0 END AS wins,
                    CASE WHEN m.margin < 0 THEN 1 ELSE 0 END AS losses,
                    CASE WHEN m.margin = 0 THEN 1 ELSE 0 END AS draws
                FROM matches m
                JOIN seasons s ON s.id = m.season_id
                WHERE {where}
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
                WHERE {where}
            )
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
            ORDER BY premiership_points DESC, percentage DESC""",
        all_params,
    )


# ---------------------------------------------------------------------------
# Tool 3: stat_leaders
# ---------------------------------------------------------------------------


def stat_leaders(
    stat: str,
    season: int | None = None,
    limit: int = 10,
) -> list[dict]:
    """Get the top players for a given statistic.

    Args:
        stat: Column name from player_match_stats (e.g. "goals",
            "disposals", "tackles").
        season: If provided, leaders for that season only.
            If omitted, career totals.
        limit: Number of results to return.

    Returns:
        List of dicts with first_name, surname, total.

    Raises:
        ValueError: If stat is not a valid column name.
    """
    if stat not in VALID_STAT_COLUMNS:
        raise ValueError(
            f"Invalid stat column: {stat!r}. "
            f"Valid columns: {', '.join(sorted(VALID_STAT_COLUMNS))}"
        )

    conditions = []
    params: list = []

    if season is not None:
        conditions.append("s.year = %s")
        params.append(season)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    params.append(limit)

    return execute_query(
        f"""SELECT p.first_name, p.surname,
                   SUM(pms.{stat})::int AS total
            FROM player_match_stats pms
            JOIN players p ON p.id = pms.player_id
            JOIN matches m ON m.id = pms.match_id
            JOIN seasons s ON s.id = m.season_id
            {where}
            GROUP BY p.id, p.first_name, p.surname
            HAVING SUM(pms.{stat}) IS NOT NULL
            ORDER BY total DESC
            LIMIT %s""",
        params,
    )


# ---------------------------------------------------------------------------
# Tool 4: head_to_head
# ---------------------------------------------------------------------------


def head_to_head(
    team1: str,
    team2: str,
    year_from: int | None = None,
    year_to: int | None = None,
) -> dict:
    """Get the head-to-head record between two teams.

    Args:
        team1: First team name (or alias).
        team2: Second team name (or alias).
        year_from: Start year filter (inclusive).
        year_to: End year filter (inclusive).

    Returns:
        Dict with team1, team2, team1_wins, team2_wins, draws,
        total_matches, and recent_matches list.
    """
    t1 = _resolve_team_name(team1)
    t2 = _resolve_team_name(team2)

    conditions = [
        "((ht.name = %s AND at.name = %s) OR (ht.name = %s AND at.name = %s))"
    ]
    params: list = [t1, t2, t2, t1]

    if year_from is not None:
        conditions.append("s.year >= %s")
        params.append(year_from)
    if year_to is not None:
        conditions.append("s.year <= %s")
        params.append(year_to)

    where = " AND ".join(conditions)

    rows = execute_query(
        f"""SELECT
                m.date, m.round, s.year,
                v.name AS venue,
                ht.name AS home_team, at.name AS away_team,
                m.home_points, m.away_points, m.margin
            FROM matches m
            JOIN teams ht ON ht.id = m.home_team_id
            JOIN teams at ON at.id = m.away_team_id
            JOIN seasons s ON s.id = m.season_id
            LEFT JOIN venues v ON v.id = m.venue_id
            WHERE {where}
            ORDER BY m.date""",
        params,
    )

    t1_wins = 0
    t2_wins = 0
    draws = 0

    for row in rows:
        if row["margin"] == 0:
            draws += 1
        elif (row["home_team"] == t1 and row["margin"] > 0) or (
            row["away_team"] == t1 and row["margin"] < 0
        ):
            t1_wins += 1
        else:
            t2_wins += 1

    return {
        "team1": t1,
        "team2": t2,
        "team1_wins": t1_wins,
        "team2_wins": t2_wins,
        "draws": draws,
        "total_matches": len(rows),
        "recent_matches": rows[-5:] if rows else [],
    }


# ---------------------------------------------------------------------------
# Tool 5: player_career_summary
# ---------------------------------------------------------------------------


def player_career_summary(
    player_id: int | None = None,
    player_name: str | None = None,
) -> dict:
    """Get a career summary for a player.

    Args:
        player_id: Player database ID.
        player_name: Player name to search for (used if player_id
            not provided).

    Returns:
        Dict with player info, career totals, seasons played,
        and teams.

    Raises:
        ValueError: If neither player_id nor player_name provided,
            or if player not found.
    """
    player_id = _resolve_player_id(player_id, player_name)

    bio = execute_query(
        """SELECT id, first_name, surname, height_cm, weight_kg
           FROM players WHERE id = %s""",
        [player_id],
    )
    if not bio:
        raise ValueError(f"No player with id {player_id}.")

    totals = execute_query(
        """SELECT
               COUNT(*) AS games,
               SUM(goals)::int AS goals,
               SUM(disposals)::int AS disposals,
               SUM(kicks)::int AS kicks,
               SUM(handballs)::int AS handballs,
               SUM(marks)::int AS marks,
               SUM(tackles)::int AS tackles,
               SUM(brownlow_votes)::int AS brownlow_votes,
               ROUND(AVG(disposals), 1) AS avg_disposals,
               ROUND(AVG(goals), 1) AS avg_goals,
               MIN(m.date) AS debut,
               MAX(m.date) AS last_game
           FROM player_match_stats pms
           JOIN matches m ON m.id = pms.match_id
           WHERE pms.player_id = %s""",
        [player_id],
    )

    seasons = execute_query(
        """SELECT s.year, t.name AS team, COUNT(*) AS games,
                  SUM(goals)::int AS goals,
                  SUM(disposals)::int AS disposals,
                  ROUND(AVG(disposals), 1) AS avg_disposals
           FROM player_match_stats pms
           JOIN matches m ON m.id = pms.match_id
           JOIN seasons s ON s.id = m.season_id
           JOIN teams t ON t.id = pms.team_id
           WHERE pms.player_id = %s
           GROUP BY s.year, t.name
           ORDER BY s.year""",
        [player_id],
    )

    return {
        "player": bio[0],
        "career": totals[0] if totals else {},
        "seasons": seasons,
    }


# ---------------------------------------------------------------------------
# Tool 6: player_comparison
# ---------------------------------------------------------------------------


def player_comparison(
    player_ids: list[int],
    year_from: int | None = None,
    year_to: int | None = None,
) -> list[dict]:
    """Compare career or filtered stats for multiple players.

    Args:
        player_ids: List of player IDs to compare.
        year_from: Start year filter (inclusive).
        year_to: End year filter (inclusive).

    Returns:
        List of dicts (one per player) with aggregated stats.
    """
    conditions = ["pms.player_id = ANY(%s)"]
    params: list = [player_ids]

    if year_from is not None:
        conditions.append("s.year >= %s")
        params.append(year_from)
    if year_to is not None:
        conditions.append("s.year <= %s")
        params.append(year_to)

    where = " AND ".join(conditions)

    return execute_query(
        f"""SELECT
                p.id, p.first_name, p.surname,
                COUNT(*) AS games,
                SUM(goals)::int AS goals,
                ROUND(AVG(goals), 2) AS avg_goals,
                SUM(disposals)::int AS disposals,
                ROUND(AVG(disposals), 1) AS avg_disposals,
                SUM(kicks)::int AS kicks,
                SUM(handballs)::int AS handballs,
                SUM(marks)::int AS marks,
                SUM(tackles)::int AS tackles,
                SUM(contested_possessions)::int AS contested_possessions,
                SUM(clearances)::int AS clearances,
                SUM(inside_fifties)::int AS inside_fifties,
                SUM(brownlow_votes)::int AS brownlow_votes
            FROM player_match_stats pms
            JOIN players p ON p.id = pms.player_id
            JOIN matches m ON m.id = pms.match_id
            JOIN seasons s ON s.id = m.season_id
            WHERE {where}
            GROUP BY p.id, p.first_name, p.surname
            ORDER BY games DESC""",
        params,
    )


# ---------------------------------------------------------------------------
# Tool 7: search_matches
# ---------------------------------------------------------------------------


def search_matches(
    team: str | None = None,
    venue: str | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    min_margin: int | None = None,
    max_margin: int | None = None,
    limit: int = 20,
) -> list[dict]:
    """Search for matches by various criteria.

    Args:
        team: Team name (or alias) — matches where team played
            home or away.
        venue: Venue name filter.
        year_from: Start year (inclusive).
        year_to: End year (inclusive).
        min_margin: Minimum absolute margin.
        max_margin: Maximum absolute margin (for close games).
        limit: Maximum results.

    Returns:
        List of match dicts with date, round, venue, teams, scores.
    """
    conditions: list[str] = []
    params: list = []

    if team is not None:
        resolved = _resolve_team_name(team)
        conditions.append("(ht.name = %s OR at.name = %s)")
        params.extend([resolved, resolved])

    if venue is not None:
        conditions.append("v.name ILIKE %s")
        params.append(f"%{venue}%")

    if year_from is not None:
        conditions.append("s.year >= %s")
        params.append(year_from)

    if year_to is not None:
        conditions.append("s.year <= %s")
        params.append(year_to)

    if min_margin is not None:
        conditions.append("ABS(m.margin) >= %s")
        params.append(min_margin)

    if max_margin is not None:
        conditions.append("ABS(m.margin) <= %s")
        params.append(max_margin)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    params.append(limit)

    return execute_query(
        f"""SELECT
                m.date, m.round, s.year, v.name AS venue,
                ht.name AS home_team, at.name AS away_team,
                m.home_points, m.away_points, m.margin
            FROM matches m
            JOIN teams ht ON ht.id = m.home_team_id
            JOIN teams at ON at.id = m.away_team_id
            JOIN seasons s ON s.id = m.season_id
            LEFT JOIN venues v ON v.id = m.venue_id
            {where}
            ORDER BY m.date DESC
            LIMIT %s""",
        params,
    )


# ---------------------------------------------------------------------------
# Tool 8: get_pav_leaders
# ---------------------------------------------------------------------------


def get_pav_leaders(
    year: int,
    zone: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Get the PAV leaderboard for a season.

    Args:
        year: Season year (1998 onwards).
        zone: Optional zone to sort by ("off", "mid", "def").
            If omitted, sorts by total_pav.
        limit: Number of results.

    Returns:
        List of dicts with player name, team, and PAV components.

    Raises:
        ValueError: If zone is invalid.
    """
    if zone is not None and zone not in _PAV_ZONE_COLUMNS:
        raise ValueError(
            f"Invalid zone: {zone!r}. "
            f"Valid zones: {', '.join(sorted(_PAV_ZONE_COLUMNS))}"
        )

    sort_col = _PAV_ZONE_COLUMNS[zone] if zone else "total_pav"

    return execute_query(
        f"""SELECT p.first_name, p.surname, t.name AS team,
                   psp.off_pav, psp.mid_pav, psp.def_pav, psp.total_pav
            FROM player_season_pav psp
            JOIN players p ON p.id = psp.player_id
            JOIN teams t ON t.id = psp.team_id
            JOIN seasons s ON s.id = psp.season_id
            WHERE s.year = %s
            ORDER BY {sort_col} DESC
            LIMIT %s""",
        [year, limit],
    )


# ---------------------------------------------------------------------------
# Tool 9: get_player_pav
# ---------------------------------------------------------------------------


def get_player_pav(
    player_id: int | None = None,
    player_name: str | None = None,
) -> list[dict]:
    """Get a player's PAV history across all seasons.

    Args:
        player_id: Player database ID.
        player_name: Player name to search for (used if player_id
            not provided).

    Returns:
        List of dicts with year, team, and PAV components.

    Raises:
        ValueError: If neither player_id nor player_name provided,
            or if player not found.
    """
    player_id = _resolve_player_id(player_id, player_name)

    return execute_query(
        """SELECT s.year, t.name AS team,
                  psp.off_pav, psp.mid_pav, psp.def_pav, psp.total_pav
           FROM player_season_pav psp
           JOIN seasons s ON s.id = psp.season_id
           JOIN teams t ON t.id = psp.team_id
           WHERE psp.player_id = %s
           ORDER BY s.year""",
        [player_id],
    )
