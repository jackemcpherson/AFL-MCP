"""MCP server exposing AFL statistics tools via FastMCP.

Provides low-level SQL tools and high-level AFL statistics tools
for LLM consumption over the MCP protocol.
"""

from __future__ import annotations

from starlette.requests import Request
from starlette.responses import JSONResponse

from fastmcp import FastMCP

mcp = FastMCP("AFL-MCP")


@mcp.custom_route("/health", methods=["GET"])
async def health(request: Request) -> JSONResponse:
    """Health check endpoint for load balancers and uptime monitors."""
    return JSONResponse({"status": "ok"})


@mcp.tool()
def execute_sql(sql: str) -> list[dict]:
    """Execute a read-only SQL query against the AFL statistics database.

    The database contains AFL Men's match results and player statistics from 1990 to the current season (updated automatically every 6 hours during the season).

    Tables:
    - competitions (id, code, name): AFLM/AFLW codes
    - seasons (id, competition_id, year): season years
    - teams (id, name, abbreviation, competition_id): team names
    - venues (id, name): match venue names
    - players (id, first_name, surname, external_id, height_cm, weight_kg, is_retired):
      player biographical data. NOTE: no team_id -- use player_match_stats.team_id for
      which team a player was on in each game.
    - matches (id, season_id, round, round_number, round_type, date, local_time,
      venue_id, home_team_id, away_team_id, home/away_goals/behinds/points, margin,
      attendance, weather_temp_c, weather_type): match results and metadata
    - player_match_stats (id, match_id, player_id, team_id, guernsey_number,
      player_position, subbed, time_on_ground_pct, kicks, handballs, disposals,
      effective_disposals, disposal_efficiency_pct, marks, bounces, tackles,
      one_percenters, clangers, contested_possessions, uncontested_possessions,
      goals, behinds, goal_assists, shots_at_goal, score_involvements, score_launches,
      centre_clearances, stoppage_clearances, clearances, contested_marks,
      marks_inside_fifty, intercept_marks, marks_on_lead, free_kicks_for,
      free_kicks_against, hitouts, hitouts_to_advantage, hitout_win_pct, ruck_contests,
      inside_fifties, rebounds, turnovers, intercepts, metres_gained, pressure_acts,
      def_half_pressure_acts, tackles_inside_fifty, spoils, contest_def_losses,
      contest_def_one_on_ones, contest_off_one_on_ones, contest_off_wins,
      effective_kicks, ground_ball_gets, f50_ground_ball_gets, brownlow_votes,
      rating_points, afl_fantasy_score, supercoach_score): per-player per-match stats

    Only SELECT queries are allowed. The query has a 30-second timeout.

    Args:
        sql: A valid SQL SELECT query.

    Returns:
        List of dicts, one per result row.

    Raises:
        ValueError: If the query contains a forbidden write statement.
    """
    from afl_mcp.core.queries import execute_query

    return execute_query(sql)


@mcp.tool()
def get_schema(table_name: str | None = None) -> dict:
    """Get database schema information for writing accurate SQL queries.

    Returns table names, column names, data types, and foreign key relationships.
    Use this before writing SQL to understand the database structure.

    Args:
        table_name: Optional specific table name to get columns for.
            If omitted, returns all tables and their columns.

    Returns:
        Dict with "columns" key and optionally "foreign_keys" key.
    """
    from afl_mcp.core.queries import get_schema_info, get_foreign_keys

    result: dict = {"columns": get_schema_info(table_name)}
    if not table_name:
        result["foreign_keys"] = get_foreign_keys()
    return result


# ---------------------------------------------------------------------------
# High-level tools
# ---------------------------------------------------------------------------


@mcp.tool()
def search_players(query: str, limit: int = 10) -> list[dict]:
    """Search for AFL players by name (partial or approximate match).

    Useful for finding player IDs before using other tools. Supports
    first name, surname, or full name searches.

    Args:
        query: Player name to search for (e.g. "Dustin", "Martin",
            "Dustin Martin").
        limit: Maximum number of results (default 10).

    Returns:
        List of dicts with id, first_name, surname, current_team.
    """
    from afl_mcp.core.tools import search_players as _search_players

    return _search_players(query, limit)


@mcp.tool()
def get_ladder(year: int, round_number: int | None = None) -> list[dict]:
    """Get the AFL ladder (standings) for a season.

    Computes premiership points, percentage, and position from match
    results. Only includes regular-season matches.

    Args:
        year: Season year (e.g. 2024).
        round_number: If provided, ladder as at end of that round.
            If omitted, full regular-season ladder.

    Returns:
        List of dicts ordered by ladder position with team, played,
        wins, losses, draws, points_for, points_against, percentage,
        premiership_points.
    """
    from afl_mcp.core.tools import get_ladder as _get_ladder

    return _get_ladder(year, round_number)


@mcp.tool()
def stat_leaders(stat: str, season: int | None = None, limit: int = 10) -> list[dict]:
    """Get the top players for a given statistic.

    Available stats: kicks, handballs, disposals, marks, tackles,
    goals, behinds, contested_possessions, uncontested_possessions,
    clearances, inside_fifties, rebounds, intercepts, metres_gained,
    hitouts, brownlow_votes, afl_fantasy_score, supercoach_score,
    and many more (50+ columns from player_match_stats).

    Args:
        stat: Statistic column name (e.g. "goals", "disposals").
        season: If provided, leaders for that season only.
            If omitted, career totals.
        limit: Number of results (default 10).

    Returns:
        List of dicts with first_name, surname, total.
    """
    from afl_mcp.core.tools import stat_leaders as _stat_leaders

    return _stat_leaders(stat, season, limit)


@mcp.tool()
def head_to_head(
    team1: str,
    team2: str,
    year_from: int | None = None,
    year_to: int | None = None,
) -> dict:
    """Get the head-to-head record between two AFL teams.

    Supports common team aliases (e.g. "Pies" for Collingwood,
    "Cats" for Geelong, "Dons" for Essendon).

    Args:
        team1: First team name or alias.
        team2: Second team name or alias.
        year_from: Start year filter (inclusive).
        year_to: End year filter (inclusive).

    Returns:
        Dict with team1, team2, team1_wins, team2_wins, draws,
        total_matches, and recent_matches (last 5 games).
    """
    from afl_mcp.core.tools import head_to_head as _head_to_head

    return _head_to_head(team1, team2, year_from, year_to)


@mcp.tool()
def player_career_summary(
    player_id: int | None = None,
    player_name: str | None = None,
) -> dict:
    """Get a comprehensive career summary for an AFL player.

    Provide either player_id or player_name. If a name is given,
    the best match is used.

    Args:
        player_id: Player database ID.
        player_name: Player name to search for.

    Returns:
        Dict with player bio, career totals (games, goals,
        disposals, etc.), and per-season breakdown.
    """
    from afl_mcp.core.tools import player_career_summary as _career

    return _career(player_id, player_name)


@mcp.tool()
def player_comparison(
    players: list[int | str],  # noqa: UP006
    year_from: int | None = None,
    year_to: int | None = None,
) -> list[dict]:
    """Compare stats for multiple AFL players side by side.

    Accepts player IDs (integers) or player names (strings).
    Names are resolved via search — use search_players first
    if you need to disambiguate.

    Args:
        players: List of player IDs or names to compare.
        year_from: Start year filter (inclusive).
        year_to: End year filter (inclusive).

    Returns:
        List of dicts (one per player) with aggregated stats
        including games, goals, disposals, marks, tackles,
        contested possessions, clearances, hitouts, and more.
    """
    from afl_mcp.core.tools import player_comparison as _comparison

    return _comparison(players, year_from, year_to)


@mcp.tool()
def search_matches(
    team: str | None = None,
    venue: str | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    min_margin: int | None = None,
    max_margin: int | None = None,
    limit: int = 20,
) -> list[dict]:
    """Search for AFL matches by various criteria.

    Supports filtering by team, venue, year range, and margin.
    Use max_margin for close games, min_margin for blowouts.

    Args:
        team: Team name or alias (matches where team played).
        venue: Venue name (partial match supported).
        year_from: Start year (inclusive).
        year_to: End year (inclusive).
        min_margin: Minimum absolute margin.
        max_margin: Maximum absolute margin.
        limit: Maximum results (default 20).

    Returns:
        List of match dicts with date, round, year, venue,
        home_team, away_team, home_points, away_points, margin.
    """
    from afl_mcp.core.tools import search_matches as _search_matches

    return _search_matches(
        team, venue, year_from, year_to, min_margin, max_margin, limit
    )


@mcp.tool()
def get_pav_leaders(
    year: int,
    zone: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Get the PAV (Player Approximate Value) leaderboard for a season.

    PAV is a player rating that combines team context with individual
    stats across three zones. It produces a single number representing
    a player's total contribution to their team's season.

    Interpretation:
    - 25+ : Exceptional (Brownlow contention, best in league)
    - 20-25: Great (All-Australian contender)
    - 15-20: Very good (best-22, team B&F contender)
    - 10-15: Solid contributor
    - 5-10 : Below average or limited games
    - <5   : Minimal contribution

    Component PAV of 10+ indicates All-Australian squad contention
    in that role (e.g. def_pav 10+ for a key defender).

    Available from 1998 onwards. Players who changed teams mid-season
    appear once per team stint.

    Args:
        year: Season year (1998 onwards).
        zone: Sort by zone — "off", "mid", or "def".
            If omitted, sorts by total_pav.
        limit: Number of results (default 20).

    Returns:
        List of dicts with first_name, surname, team, off_pav,
        mid_pav, def_pav, total_pav.
    """
    from afl_mcp.core.tools import get_pav_leaders as _pav_leaders

    return _pav_leaders(year, zone, limit)


@mcp.tool()
def get_player_pav(
    player_id: int | None = None,
    player_name: str | None = None,
) -> list[dict]:
    """Get a player's PAV (Player Approximate Value) history.

    Returns PAV ratings for every season the player has data,
    showing their career arc in terms of total contribution.
    See get_pav_leaders for PAV interpretation guide.

    Args:
        player_id: Player database ID.
        player_name: Player name to search for.

    Returns:
        List of dicts with year, team, off_pav, mid_pav,
        def_pav, total_pav — ordered by year.
    """
    from afl_mcp.core.tools import get_player_pav as _player_pav

    return _player_pav(player_id, player_name)
