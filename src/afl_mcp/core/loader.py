"""CSV data loader for populating PostgreSQL from extracted fitzRoy data.

Reads results.csv and player_stats.csv, normalises team and venue names,
and loads data in dependency order with idempotent upserts.
"""

from __future__ import annotations

import csv
import logging
from pathlib import Path

import psycopg

from afl_mcp.core.db import get_admin_connection

logger = logging.getLogger(__name__)

TEAM_NAME_MAP: dict[str, str] = {
    "Greater Western Sydney": "GWS Giants",
    "GWS": "GWS Giants",
    "Brisbane Bears": "Brisbane Lions",
    "Footscray": "Western Bulldogs",
}

VENUE_NAME_MAP: dict[str, str] = {
    "M.C.G.": "MCG",
    "S.C.G.": "SCG",
    "Docklands": "Marvel Stadium",
    "Etihad Stadium": "Marvel Stadium",
    "GMHBA Stadium": "Kardinia Park",
    "Manuka Oval": "Manuka Oval",
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
    "Mars Stadium": "Mars Stadium",
    "Eureka Stadium": "Mars Stadium",
    "People First Stadium": "Carrara",
    "Heritage Bank Stadium": "Carrara",
    "Carrara": "Carrara",
    "Metricon Stadium": "Carrara",
    "Perth Stadium": "Perth Stadium",
    "Optus Stadium": "Perth Stadium",
    "Gabba": "Gabba",
    "The Gabba": "Gabba",
    "York Park": "UTAS Stadium",
    "UTAS Stadium": "UTAS Stadium",
    "University of Tasmania Stadium": "UTAS Stadium",
    "Jiangwan Stadium": "Jiangwan Stadium",
    "Traeger Park": "Traeger Park",
    "Riverway Stadium": "Riverway Stadium",
    "Norwood Oval": "Norwood Oval",
}

COMPETITION_CODE = "AFLM"


def _normalise_team(name: str) -> str:
    """Normalise a team name to its canonical form.

    Args:
        name: Raw team name from CSV.

    Returns:
        Canonical team name.
    """
    return TEAM_NAME_MAP.get(name, name)


def _normalise_venue(name: str) -> str:
    """Normalise a venue name to its canonical form.

    Args:
        name: Raw venue name from CSV.

    Returns:
        Canonical venue name.
    """
    return VENUE_NAME_MAP.get(name, name)


def _int_or_none(val: str) -> int | None:
    """Parse a string to int, returning None for empty or sentinel values.

    Args:
        val: String value from CSV.

    Returns:
        Parsed integer or None.
    """
    if not val or val in ("NA", "FALSE", "TRUE"):
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def _float_or_none(val: str) -> float | None:
    """Parse a string to float, returning None for empty or sentinel values.

    Args:
        val: String value from CSV.

    Returns:
        Parsed float or None.
    """
    if not val or val in ("NA", "FALSE", "TRUE"):
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _str_or_none(val: str) -> str | None:
    """Return None for empty or NA strings, otherwise the string itself.

    Args:
        val: String value from CSV.

    Returns:
        The string or None.
    """
    if not val or val == "NA":
        return None
    return val


def _bool_from_str(val: str) -> bool | None:
    """Parse a boolean string value.

    Args:
        val: String like "TRUE" or "FALSE" from CSV.

    Returns:
        Boolean value or None.
    """
    if not val or val == "NA":
        return None
    return val.upper() == "TRUE"


def _read_csv(path: Path) -> list[dict[str, str]]:
    """Read a CSV file into a list of dicts.

    Args:
        path: Path to the CSV file.

    Returns:
        List of row dicts keyed by column header.
    """
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _ensure_competition(conn: psycopg.Connection[dict]) -> int:
    """Ensure the AFLM competition row exists and return its ID.

    Args:
        conn: Database connection.

    Returns:
        The competition ID.

    Raises:
        RuntimeError: If the row cannot be inserted or fetched.
    """
    row = conn.execute(
        "SELECT id FROM competitions WHERE code = %s", (COMPETITION_CODE,)
    ).fetchone()
    if row:
        return row["id"]
    row = conn.execute(
        "INSERT INTO competitions (code, name) VALUES (%s, %s) RETURNING id",
        (COMPETITION_CODE, "AFL Men's"),
    ).fetchone()
    if row is None:
        raise RuntimeError("Failed to insert/fetch row")
    return row["id"]


def _load_venues(
    conn: psycopg.Connection[dict],
    results: list[dict[str, str]],
    stats_data: list[dict[str, str]],
) -> dict[str, int]:
    """Load unique venues from both CSVs.

    Args:
        conn: Database connection.
        results: Rows from results.csv.
        stats_data: Rows from player_stats.csv.

    Returns:
        Mapping of normalised venue name to database ID.
    """
    raw_names: set[str] = set()
    for row in results:
        if row.get("Venue"):
            raw_names.add(row["Venue"])
    for row in stats_data:
        if row.get("venue_name"):
            raw_names.add(row["venue_name"])

    canonical_names = {_normalise_venue(n) for n in raw_names}
    mapping: dict[str, int] = {}

    for name in canonical_names:
        row = conn.execute(
            """INSERT INTO venues (name) VALUES (%s)
               ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
               RETURNING id""",
            (name,),
        ).fetchone()
        if row is None:
            raise RuntimeError("Failed to insert/fetch row")
        mapping[name] = row["id"]

    return mapping


def _load_teams(
    conn: psycopg.Connection[dict],
    results: list[dict[str, str]],
    stats_data: list[dict[str, str]],
    competition_id: int,
) -> dict[str, int]:
    """Load unique teams from both CSVs.

    Args:
        conn: Database connection.
        results: Rows from results.csv.
        stats_data: Rows from player_stats.csv.
        competition_id: The competition FK.

    Returns:
        Mapping of normalised team name to database ID.
    """
    team_names: set[str] = set()
    for row in results:
        if row.get("Home.Team"):
            team_names.add(_normalise_team(row["Home.Team"]))
        if row.get("Away.Team"):
            team_names.add(_normalise_team(row["Away.Team"]))
    for row in stats_data:
        if row.get("player_team"):
            team_names.add(_normalise_team(row["player_team"]))
        if row.get("match_home_team"):
            team_names.add(_normalise_team(row["match_home_team"]))
        if row.get("match_away_team"):
            team_names.add(_normalise_team(row["match_away_team"]))

    mapping: dict[str, int] = {}
    for name in team_names:
        row = conn.execute(
            """INSERT INTO teams (name, competition_id) VALUES (%s, %s)
               ON CONFLICT (name, competition_id) DO UPDATE SET name = EXCLUDED.name
               RETURNING id""",
            (name, competition_id),
        ).fetchone()
        if row is None:
            raise RuntimeError("Failed to insert/fetch row")
        mapping[name] = row["id"]

    return mapping


def _load_seasons(
    conn: psycopg.Connection[dict],
    results: list[dict[str, str]],
    competition_id: int,
) -> dict[int, int]:
    """Load unique seasons from results.csv.

    Args:
        conn: Database connection.
        results: Rows from results.csv.
        competition_id: The competition FK.

    Returns:
        Mapping of year to database ID.
    """
    years = {int(row["Date"][:4]) for row in results if row.get("Date")}

    mapping: dict[int, int] = {}
    for year in years:
        row = conn.execute(
            """INSERT INTO seasons (competition_id, year) VALUES (%s, %s)
               ON CONFLICT (competition_id, year) DO UPDATE SET year = EXCLUDED.year
               RETURNING id""",
            (competition_id, year),
        ).fetchone()
        if row is None:
            raise RuntimeError("Failed to insert/fetch row")
        mapping[year] = row["id"]

    return mapping


def _load_players(
    conn: psycopg.Connection[dict],
    stats_data: list[dict[str, str]],
) -> dict[str, int]:
    """Load unique players from player_stats.csv.

    Args:
        conn: Database connection.
        stats_data: Rows from player_stats.csv.

    Returns:
        Mapping of external player ID to database ID.
    """
    seen: dict[str, dict[str, str]] = {}
    for row in stats_data:
        pid = row.get("player_id", "")
        if not pid:
            continue
        if pid not in seen:
            seen[pid] = dict(row)
        else:
            # Prefer rows that have height/weight data
            if not seen[pid].get("player_height_cm") and row.get("player_height_cm"):
                seen[pid]["player_height_cm"] = row["player_height_cm"]
            if not seen[pid].get("player_weight_kg") and row.get("player_weight_kg"):
                seen[pid]["player_weight_kg"] = row["player_weight_kg"]

    mapping: dict[str, int] = {}
    for pid, s in seen.items():
        surname = s.get("player_last_name", "")
        if not surname:
            continue

        row = conn.execute(
            """INSERT INTO players (first_name, surname, external_id,
                                    height_cm, weight_kg, is_retired)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (external_id) DO UPDATE SET
                   first_name = EXCLUDED.first_name,
                   surname = EXCLUDED.surname,
                   height_cm = COALESCE(EXCLUDED.height_cm, players.height_cm),
                   weight_kg = COALESCE(EXCLUDED.weight_kg, players.weight_kg),
                   is_retired = EXCLUDED.is_retired
               RETURNING id""",
            (
                _str_or_none(s.get("player_first_name", "")),
                surname,
                pid,
                _int_or_none(s.get("player_height_cm", "")),
                _int_or_none(s.get("player_weight_kg", "")),
                _bool_from_str(s.get("player_is_retired", "")),
            ),
        ).fetchone()
        if row is None:
            raise RuntimeError("Failed to insert/fetch row")
        mapping[pid] = row["id"]

    return mapping


def _load_matches(
    conn: psycopg.Connection[dict],
    results: list[dict[str, str]],
    season_map: dict[int, int],
    team_map: dict[str, int],
    venue_map: dict[str, int],
) -> int:
    """Load matches from results.csv.

    Args:
        conn: Database connection.
        results: Rows from results.csv.
        season_map: Year to season ID mapping.
        team_map: Team name to team ID mapping.
        venue_map: Venue name to venue ID mapping.

    Returns:
        Number of matches loaded.
    """
    count = 0
    for r in results:
        game_id = r.get("Game", "")
        if not game_id:
            continue

        date = _str_or_none(r.get("Date", ""))
        year = int(r["Date"][:4]) if date else None
        season_id = season_map.get(year) if year else None
        if season_id is None:
            continue

        home_team = _normalise_team(r.get("Home.Team", ""))
        away_team = _normalise_team(r.get("Away.Team", ""))
        venue_name = _normalise_venue(r.get("Venue", ""))

        conn.execute(
            """INSERT INTO matches (season_id, round, round_number, round_type, date,
                                    venue_id, home_team_id, away_team_id,
                                    home_goals, home_behinds, home_points,
                                    away_goals, away_behinds, away_points,
                                    margin, external_afltables_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (external_afltables_id) DO UPDATE SET
                   home_goals = EXCLUDED.home_goals,
                   home_behinds = EXCLUDED.home_behinds,
                   home_points = EXCLUDED.home_points,
                   away_goals = EXCLUDED.away_goals,
                   away_behinds = EXCLUDED.away_behinds,
                   away_points = EXCLUDED.away_points,
                   margin = EXCLUDED.margin""",
            (
                season_id,
                r.get("Round", ""),
                _int_or_none(r.get("Round.Number", "")),
                r.get("Round.Type", "Regular"),
                date,
                venue_map.get(venue_name),
                team_map.get(home_team),
                team_map.get(away_team),
                _int_or_none(r.get("Home.Goals", "")),
                _int_or_none(r.get("Home.Behinds", "")),
                _int_or_none(r.get("Home.Points", "")),
                _int_or_none(r.get("Away.Goals", "")),
                _int_or_none(r.get("Away.Behinds", "")),
                _int_or_none(r.get("Away.Points", "")),
                _int_or_none(r.get("Margin", "")),
                game_id,
            ),
        )
        count += 1

    conn.commit()
    return count


def _enrich_matches_from_stats(
    conn: psycopg.Connection[dict],
    stats_data: list[dict[str, str]],
    team_map: dict[str, int],
) -> int:
    """Add metadata from player_stats.csv to matches.

    Populates local_time, attendance, weather, and the fryzigg
    external ID, matched by date and home/away team.

    Args:
        conn: Database connection.
        stats_data: Rows from player_stats.csv.
        team_map: Team name to team ID mapping.

    Returns:
        Number of matches enriched.
    """
    seen_matches: dict[tuple[str, str, str], dict[str, str]] = {}
    for row in stats_data:
        date = row.get("match_date", "")[:10]
        home = _normalise_team(row.get("match_home_team", ""))
        away = _normalise_team(row.get("match_away_team", ""))
        key = (date, home, away)
        if key not in seen_matches:
            seen_matches[key] = row

    count = 0
    for (date, home, away), s in seen_matches.items():
        home_id = team_map.get(home)
        away_id = team_map.get(away)
        if not home_id or not away_id:
            continue

        local_time = _str_or_none(s.get("match_local_time", ""))
        attendance = _int_or_none(s.get("match_attendance", ""))
        if attendance == 0:
            attendance = None
        weather_temp = _float_or_none(s.get("match_weather_temp_c", ""))
        weather_type = _str_or_none(s.get("match_weather_type", ""))
        fryzigg_id = _str_or_none(s.get("match_id", ""))

        result = conn.execute(
            """UPDATE matches SET
                   local_time = COALESCE(%s::time, local_time),
                   attendance = COALESCE(%s, attendance),
                   weather_temp_c = COALESCE(%s, weather_temp_c),
                   weather_type = COALESCE(%s, weather_type),
                   external_fryzigg_id = COALESCE(%s, external_fryzigg_id)
               WHERE date = %s AND home_team_id = %s AND away_team_id = %s""",
            (
                local_time,
                attendance,
                weather_temp,
                weather_type,
                fryzigg_id,
                date,
                home_id,
                away_id,
            ),
        )
        if result.rowcount == 0:
            # Try swapped home/away (sources sometimes disagree)
            conn.execute(
                """UPDATE matches SET
                       local_time = COALESCE(%s::time, local_time),
                       attendance = COALESCE(%s, attendance),
                       weather_temp_c = COALESCE(%s, weather_temp_c),
                       weather_type = COALESCE(%s, weather_type),
                       external_fryzigg_id = COALESCE(%s, external_fryzigg_id)
                   WHERE date = %s AND home_team_id = %s AND away_team_id = %s""",
                (
                    local_time,
                    attendance,
                    weather_temp,
                    weather_type,
                    fryzigg_id,
                    date,
                    away_id,
                    home_id,
                ),
            )
        count += 1

    conn.commit()
    return count


def _build_match_lookup(
    conn: psycopg.Connection[dict],
) -> dict[tuple[str, str, str], int]:
    """Build a lookup from (date, home_team, away_team) to match ID.

    Args:
        conn: Database connection.

    Returns:
        Dict mapping the tuple key to the match database ID.
    """
    rows = conn.execute("""
        SELECT m.id, m.date, ht.name AS home_team, at.name AS away_team
        FROM matches m
        JOIN teams ht ON ht.id = m.home_team_id
        JOIN teams at ON at.id = m.away_team_id
    """).fetchall()
    lookup: dict[tuple[str, str, str], int] = {}
    for r in rows:
        date_str = str(r["date"]) if r["date"] else ""
        lookup[(date_str, r["home_team"], r["away_team"])] = r["id"]
        # Also index with swapped home/away for sources that disagree
        lookup[(date_str, r["away_team"], r["home_team"])] = r["id"]
    return lookup


def _load_player_match_stats(
    conn: psycopg.Connection[dict],
    stats_data: list[dict[str, str]],
    player_map: dict[str, int],
    team_map: dict[str, int],
) -> int:
    """Load player match stats from player_stats.csv.

    Args:
        conn: Database connection.
        stats_data: Rows from player_stats.csv.
        player_map: External player ID to database ID mapping.
        team_map: Team name to team ID mapping.

    Returns:
        Number of stat rows loaded.
    """
    count = 0
    match_lookup = _build_match_lookup(conn)

    for s in stats_data:
        match_date = s.get("match_date", "")[:10]
        home_team = _normalise_team(s.get("match_home_team", ""))
        away_team = _normalise_team(s.get("match_away_team", ""))
        match_id = match_lookup.get((match_date, home_team, away_team))
        if match_id is None:
            continue

        player_id = player_map.get(s.get("player_id", ""))
        if player_id is None:
            continue

        team_name = _normalise_team(s.get("player_team", ""))
        team_id = team_map.get(team_name)
        if team_id is None:
            continue

        conn.execute(
            """INSERT INTO player_match_stats (
                   match_id, player_id, team_id,
                   guernsey_number, player_position, subbed,
                   time_on_ground_pct,
                   kicks, handballs, disposals, effective_disposals,
                   disposal_efficiency_pct, marks, bounces, tackles,
                   one_percenters, clangers,
                   contested_possessions, uncontested_possessions,
                   goals, behinds, goal_assists, shots_at_goal,
                   score_involvements, score_launches,
                   centre_clearances, stoppage_clearances, clearances,
                   contested_marks, marks_inside_fifty, intercept_marks, marks_on_lead,
                   free_kicks_for, free_kicks_against,
                   hitouts, hitouts_to_advantage, hitout_win_pct, ruck_contests,
                   inside_fifties, rebounds, turnovers, intercepts, metres_gained,
                   pressure_acts, def_half_pressure_acts,
                   tackles_inside_fifty, spoils,
                   contest_def_losses, contest_def_one_on_ones,
                   contest_off_one_on_ones, contest_off_wins,
                   effective_kicks,
                   ground_ball_gets, f50_ground_ball_gets,
                   brownlow_votes, rating_points,
                   afl_fantasy_score, supercoach_score
               ) VALUES (
                   %s, %s, %s,
                   %s, %s, %s,
                   %s,
                   %s, %s, %s, %s,
                   %s, %s, %s, %s,
                   %s, %s,
                   %s, %s,
                   %s, %s, %s, %s,
                   %s, %s,
                   %s, %s, %s,
                   %s, %s, %s, %s,
                   %s, %s,
                   %s, %s, %s, %s,
                   %s, %s, %s, %s, %s,
                   %s, %s,
                   %s, %s,
                   %s, %s,
                   %s, %s,
                   %s,
                   %s, %s,
                   %s, %s,
                   %s, %s
               )
               ON CONFLICT (match_id, player_id) DO UPDATE SET
                   team_id = EXCLUDED.team_id,
                   guernsey_number = EXCLUDED.guernsey_number,
                   player_position = EXCLUDED.player_position,
                   subbed = EXCLUDED.subbed,
                   time_on_ground_pct = EXCLUDED.time_on_ground_pct,
                   kicks = EXCLUDED.kicks,
                   handballs = EXCLUDED.handballs,
                   disposals = EXCLUDED.disposals,
                   effective_disposals = EXCLUDED.effective_disposals,
                   disposal_efficiency_pct = EXCLUDED.disposal_efficiency_pct,
                   marks = EXCLUDED.marks,
                   bounces = EXCLUDED.bounces,
                   tackles = EXCLUDED.tackles,
                   one_percenters = EXCLUDED.one_percenters,
                   clangers = EXCLUDED.clangers,
                   contested_possessions = EXCLUDED.contested_possessions,
                   uncontested_possessions = EXCLUDED.uncontested_possessions,
                   goals = EXCLUDED.goals,
                   behinds = EXCLUDED.behinds,
                   goal_assists = EXCLUDED.goal_assists,
                   shots_at_goal = EXCLUDED.shots_at_goal,
                   score_involvements = EXCLUDED.score_involvements,
                   score_launches = EXCLUDED.score_launches,
                   centre_clearances = EXCLUDED.centre_clearances,
                   stoppage_clearances = EXCLUDED.stoppage_clearances,
                   clearances = EXCLUDED.clearances,
                   contested_marks = EXCLUDED.contested_marks,
                   marks_inside_fifty = EXCLUDED.marks_inside_fifty,
                   intercept_marks = EXCLUDED.intercept_marks,
                   marks_on_lead = EXCLUDED.marks_on_lead,
                   free_kicks_for = EXCLUDED.free_kicks_for,
                   free_kicks_against = EXCLUDED.free_kicks_against,
                   hitouts = EXCLUDED.hitouts,
                   hitouts_to_advantage = EXCLUDED.hitouts_to_advantage,
                   hitout_win_pct = EXCLUDED.hitout_win_pct,
                   ruck_contests = EXCLUDED.ruck_contests,
                   inside_fifties = EXCLUDED.inside_fifties,
                   rebounds = EXCLUDED.rebounds,
                   turnovers = EXCLUDED.turnovers,
                   intercepts = EXCLUDED.intercepts,
                   metres_gained = EXCLUDED.metres_gained,
                   pressure_acts = EXCLUDED.pressure_acts,
                   def_half_pressure_acts = EXCLUDED.def_half_pressure_acts,
                   tackles_inside_fifty = EXCLUDED.tackles_inside_fifty,
                   spoils = EXCLUDED.spoils,
                   contest_def_losses = EXCLUDED.contest_def_losses,
                   contest_def_one_on_ones = EXCLUDED.contest_def_one_on_ones,
                   contest_off_one_on_ones = EXCLUDED.contest_off_one_on_ones,
                   contest_off_wins = EXCLUDED.contest_off_wins,
                   effective_kicks = EXCLUDED.effective_kicks,
                   ground_ball_gets = EXCLUDED.ground_ball_gets,
                   f50_ground_ball_gets = EXCLUDED.f50_ground_ball_gets,
                   brownlow_votes = EXCLUDED.brownlow_votes,
                   rating_points = EXCLUDED.rating_points,
                   afl_fantasy_score = EXCLUDED.afl_fantasy_score,
                   supercoach_score = EXCLUDED.supercoach_score""",
            (
                match_id,
                player_id,
                team_id,
                _int_or_none(s.get("guernsey_number", "")),
                _str_or_none(s.get("player_position", "")),
                _str_or_none(s.get("subbed", "")),
                _float_or_none(s.get("time_on_ground_percentage", "")),
                _int_or_none(s.get("kicks", "")),
                _int_or_none(s.get("handballs", "")),
                _int_or_none(s.get("disposals", "")),
                _int_or_none(s.get("effective_disposals", "")),
                _float_or_none(s.get("disposal_efficiency_percentage", "")),
                _int_or_none(s.get("marks", "")),
                _int_or_none(s.get("bounces", "")),
                _int_or_none(s.get("tackles", "")),
                _int_or_none(s.get("one_percenters", "")),
                _int_or_none(s.get("clangers", "")),
                _int_or_none(s.get("contested_possessions", "")),
                _int_or_none(s.get("uncontested_possessions", "")),
                _int_or_none(s.get("goals", "")),
                _int_or_none(s.get("behinds", "")),
                _int_or_none(s.get("goal_assists", "")),
                _int_or_none(s.get("shots_at_goal", "")),
                _int_or_none(s.get("score_involvements", "")),
                _int_or_none(s.get("score_launches", "")),
                _int_or_none(s.get("centre_clearances", "")),
                _int_or_none(s.get("stoppage_clearances", "")),
                _int_or_none(s.get("clearances", "")),
                _int_or_none(s.get("contested_marks", "")),
                _int_or_none(s.get("marks_inside_fifty", "")),
                _int_or_none(s.get("intercept_marks", "")),
                _int_or_none(s.get("marks_on_lead", "")),
                _int_or_none(s.get("free_kicks_for", "")),
                _int_or_none(s.get("free_kicks_against", "")),
                _int_or_none(s.get("hitouts", "")),
                _int_or_none(s.get("hitouts_to_advantage", "")),
                _float_or_none(s.get("hitout_win_percentage", "")),
                _int_or_none(s.get("ruck_contests", "")),
                _int_or_none(s.get("inside_fifties", "")),
                _int_or_none(s.get("rebounds", "")),
                _int_or_none(s.get("turnovers", "")),
                _int_or_none(s.get("intercepts", "")),
                _int_or_none(s.get("metres_gained", "")),
                _int_or_none(s.get("pressure_acts", "")),
                _int_or_none(s.get("def_half_pressure_acts", "")),
                _int_or_none(s.get("tackles_inside_fifty", "")),
                _int_or_none(s.get("spoils", "")),
                _int_or_none(s.get("contest_def_losses", "")),
                _int_or_none(s.get("contest_def_one_on_ones", "")),
                _int_or_none(s.get("contest_off_one_on_ones", "")),
                _int_or_none(s.get("contest_off_wins", "")),
                _int_or_none(s.get("effective_kicks", "")),
                _int_or_none(s.get("ground_ball_gets", "")),
                _int_or_none(s.get("f50_ground_ball_gets", "")),
                _int_or_none(s.get("brownlow_votes", "")),
                _float_or_none(s.get("rating_points", "")),
                _int_or_none(s.get("afl_fantasy_score", "")),
                _int_or_none(s.get("supercoach_score", "")),
            ),
        )
        count += 1

        if count % 5000 == 0:
            conn.commit()

    conn.commit()
    return count


def load_all(data_dir: str | Path) -> dict[str, int]:
    """Load all CSV data into the database.

    Reads results.csv and player_stats.csv from the given directory
    and loads data in dependency order: venues, teams, seasons,
    players, matches, match metadata enrichment, player match stats.

    Args:
        data_dir: Path to directory containing the CSV files.

    Returns:
        Dict mapping table name to number of rows loaded.
    """
    data_dir = Path(data_dir)
    counts: dict[str, int] = {}

    results_data = _read_csv(data_dir / "results.csv")
    stats_data = _read_csv(data_dir / "player_stats.csv")

    with get_admin_connection() as conn:
        competition_id = _ensure_competition(conn)

        venue_map = _load_venues(conn, results_data, stats_data)
        counts["venues"] = len(venue_map)
        conn.commit()

        team_map = _load_teams(conn, results_data, stats_data, competition_id)
        counts["teams"] = len(team_map)
        conn.commit()

        season_map = _load_seasons(conn, results_data, competition_id)
        counts["seasons"] = len(season_map)
        conn.commit()

        player_map = _load_players(conn, stats_data)
        counts["players"] = len(player_map)
        conn.commit()

        match_count = _load_matches(conn, results_data, season_map, team_map, venue_map)
        counts["matches"] = match_count

        enriched = _enrich_matches_from_stats(conn, stats_data, team_map)
        counts["matches_enriched"] = enriched

        stats_count = _load_player_match_stats(conn, stats_data, player_map, team_map)
        counts["player_match_stats"] = stats_count

    logger.info("Load complete: %s", counts)
    return counts
