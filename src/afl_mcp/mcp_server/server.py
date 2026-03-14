"""MCP server exposing AFL statistics tools via FastMCP.

Provides execute_sql and get_schema tools for LLM consumption over
the MCP protocol.
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

    The database contains AFL Men's match results and player statistics from 2016-2025.

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
