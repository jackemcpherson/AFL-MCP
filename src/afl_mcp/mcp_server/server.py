"""MCP server exposing AFL statistics tools via FastMCP.

Provides five tools for LLM consumption over the MCP protocol:
execute_sql, get_schema, get_ladder, search_afl, get_last_updated.
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

    The database contains AFL Men's match results and player statistics
    from 1990 to the current season, updated automatically every 6 hours
    during the season.

    Tables:
    - competitions (id, code, name)
    - seasons (id, competition_id, year)
    - teams (id, name, abbreviation, competition_id)
    - venues (id, name)
    - players (id, first_name, surname, external_id, date_of_birth,
      height_cm, weight_kg, is_retired): player biographical data.
      NOTE: no team_id column — a player's team is determined per-game
      via player_match_stats.team_id.
    - matches (id, season_id, round, round_number, round_type, date,
      local_time, venue_id, home_team_id, away_team_id,
      home/away_goals/behinds/points, margin, attendance,
      weather_temp_c, weather_type, external_afltables_id,
      external_fryzigg_id)
    - player_match_stats (id, match_id, player_id, team_id,
      guernsey_number, player_position, subbed, time_on_ground_pct,
      kicks, handballs, disposals, effective_disposals,
      disposal_efficiency_pct, marks, bounces, tackles, one_percenters,
      clangers, contested_possessions, uncontested_possessions, goals,
      behinds, goal_assists, shots_at_goal, score_involvements,
      score_launches, centre_clearances, stoppage_clearances, clearances,
      contested_marks, marks_inside_fifty, intercept_marks, marks_on_lead,
      free_kicks_for, free_kicks_against, hitouts, hitouts_to_advantage,
      hitout_win_pct, ruck_contests, inside_fifties, rebounds, turnovers,
      intercepts, metres_gained, pressure_acts, def_half_pressure_acts,
      tackles_inside_fifty, spoils, contest_def_losses,
      contest_def_one_on_ones, contest_off_one_on_ones, contest_off_wins,
      effective_kicks, ground_ball_gets, f50_ground_ball_gets,
      brownlow_votes, rating_points, afl_fantasy_score,
      supercoach_score): per-player per-match statistics (50+ columns)
    - player_season_pav (id, player_id, season_id, team_id, off_pav,
      mid_pav, def_pav, total_pav): Player Approximate Value ratings per
      season. Available 1998-2025 only. One row per player per season.
      Joins to players, seasons, and teams via foreign keys.
      total_pav = off_pav + mid_pav + def_pav.
      Zone meanings:
        off_pav = offensive (goals, score involvements, forward craft)
        mid_pav = midfield (disposals, clearances, tackles, contested ball)
        def_pav = defensive (intercepts, spoils, one-percenters, rebounds)
      Interpretation:
        25+ exceptional (Brownlow contention)
        20-25 great (All-Australian)
        15-20 very good (team best-22)
        10-15 solid contributor
        5-10 below average or limited games
        <5 minimal contribution
      Zone PAV of 10+ = All-Australian contention in that role.
      Use LEFT JOIN when combining with player_match_stats — pre-1998
      seasons have stats but no PAV rows.
    - match_summaries (id, match_id, summary_text, embedding):
      one-line text summary per match. Used by the search_afl tool —
      prefer search_afl over direct SQL on this table.
    - player_season_summaries (id, player_id, season_id, summary_text,
      embedding): one-line text summary per player-season. Used by
      search_afl — prefer search_afl over direct SQL on this table.

    Common join patterns:

      Team roster PAV for a season:
        player_season_pav psp
        JOIN players p ON psp.player_id = p.id
        JOIN seasons s ON psp.season_id = s.id
        JOIN teams t ON psp.team_id = t.id
        WHERE t.name = 'X' AND s.year = YYYY
        ORDER BY psp.total_pav DESC

      Player career arc (stats + PAV by season):
        player_match_stats pms
        JOIN matches m ON pms.match_id = m.id
        JOIN seasons s ON m.season_id = s.id
        LEFT JOIN player_season_pav psp
          ON psp.player_id = pms.player_id AND psp.season_id = s.id
        WHERE pms.player_id = N
        GROUP BY s.year, psp columns
        ORDER BY s.year
        (LEFT JOIN because pre-1998 seasons have no PAV data)

      Zone leaders across the league:
        player_season_pav psp JOIN players, seasons, teams
        WHERE s.year = YYYY
        ORDER BY psp.mid_pav DESC (or off_pav, def_pav)

    Only SELECT queries allowed. 30-second timeout.

    Args:
        sql: SQL SELECT query. Write statements are rejected.

    Returns:
        List of dicts, one per row. Empty list if no rows match.
    """
    from afl_mcp.core.queries import execute_query

    return execute_query(sql)


@mcp.tool()
def get_schema(table_name: str | None = None) -> dict:
    """Get database schema information for writing accurate SQL queries.

    Returns table names, column names, data types, nullability, and
    foreign key relationships. Call without arguments for the full
    schema, or pass a table_name for a single table.

    Key tables: competitions, seasons, teams, venues, players, matches,
    player_match_stats (50+ stat columns), player_season_pav (PAV
    ratings 1998+), match_summaries, player_season_summaries.

    Args:
        table_name: Optional specific table to inspect. Omit for all tables.

    Returns:
        Dict with "columns" key and optionally "foreign_keys" key.
    """
    from afl_mcp.core.queries import get_schema_dict

    return get_schema_dict(table_name)


@mcp.tool()
def get_ladder(year: int, round_number: int | None = None) -> list[dict]:
    """Get the AFL ladder (standings) for a season.

    Computes premiership points, percentage, and position from match
    results. Only regular-season matches are included. Optionally
    provide a round_number for the ladder as at end of that round.

    Available from 1990 onwards.

    Args:
        year: Season year (e.g. 2024).
        round_number: Optional: ladder as at end of this round.

    Returns:
        List of dicts ordered by ladder position with team, played,
        wins, losses, draws, points_for, points_against, percentage,
        premiership_points.
    """
    from afl_mcp.core.tools import get_ladder as _get_ladder

    return _get_ladder(year, round_number)


@mcp.tool()
def search_afl(
    query: str,
    limit: int = 10,
    year_from: int | None = None,
    year_to: int | None = None,
    team: str | None = None,
    min_games: int | None = None,
) -> list[dict]:
    """Search across all AFL data — matches and player seasons together.

    Returns a mixed list of matches and player seasons ranked by
    relevance. Each result has a "type" field ("match" or
    "player_season") to distinguish result types.

    Hybrid search combining vector similarity with keyword matching.
    Synonym expansion and numeric filter extraction are applied
    automatically:
    - "grand final" -> GF, "preliminary final" -> PF
    - "close game" / "nail-biter" -> low margin matches
    - "blowout" / "demolition" -> high margin matches
    - "30 disposals" -> filters to AVG >= 28
    - "50 goals" -> filters to season total >= 45
    - "ruckman" -> hitouts, "midfielder" -> disposals/clearances

    Good for broad exploratory queries like "Geelong 2007",
    "dominant performances at the MCG", "close grand finals",
    "key forward 50 goals", or "Brisbane Lions 2024 season".

    Match results include:
    - rank, score, summary text
    - Full match metadata (date, round, venue, scores, margin,
      attendance, weather)
    - Top 3 performers per team ranked by AFL Fantasy score, or by
      weighted stat composite (disposals*2 + goals*6 + marks +
      tackles*2) for pre-2007 matches where fantasy scores are null

    Player season results include:
    - rank, score, summary text
    - Player info (id, name, team, year, games played)
    - PAV (Player Approximate Value) ratings when available
      (1998 onwards):
        off_pav: offensive (goals, score involvements, forward craft)
        mid_pav: midfield (disposals, clearances, tackles, contested)
        def_pav: defensive (intercepts, spoils, one-percenters)
        total_pav: sum of all three zones
      Interpretation:
        25+ exceptional (Brownlow contention)
        20-25 great (All-Australian)
        15-20 very good (team best-22)
        10-15 solid
        5-10 below average
        <5 minimal
      Zone PAV of 10+ = All-Australian contention in that role.
      PAV is null for pre-1998 seasons.

    Use min_games to filter out short cameos from player season
    results (recommend min_games=15 for meaningful results).

    Args:
        query: Natural language search text.
        limit: Maximum total results (1-50).
        year_from: Only results from this year onwards.
        year_to: Only results up to this year.
        team: Only results involving this team (aliases supported:
            Pies, Cats, Hawks, etc.).
        min_games: Minimum games played (player seasons only,
            recommend 15+).

    Returns:
        List of dicts with rank, type, score, summary, and enriched
        metadata.
    """
    from afl_mcp.core.semantic_search import search_afl as _search

    return _search(query, limit, year_from, year_to, team, min_games)


@mcp.tool()
def get_last_updated() -> dict:
    """Get data freshness metadata.

    Returns when the database was last updated, the most recent match
    and player stats available, season range, and row counts. Use this
    to check whether current-season data is loaded before querying.

    The gap between latest_match and latest_player_stats indicates
    matches where scores are in but individual stats haven't been
    processed yet (stats typically load within 6 hours of a match).

    Returns:
        Dict with latest_season, latest_match, latest_player_stats,
        seasons_available, total_matches, total_players,
        total_stat_rows, pav_available.
    """
    from afl_mcp.core.queries import get_last_updated as _get_last_updated

    return _get_last_updated()
