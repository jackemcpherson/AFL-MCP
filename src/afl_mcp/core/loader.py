"""CSV data loader for populating PostgreSQL from extracted fitzRoy data.

Supports multi-source loading with priority:
1. AFL official API (results_afl.csv, player_stats_afl.csv) — primary
2. FootyWire (results_footywire.csv) — fallback for results
3. Fryzigg (player_stats_fryzigg.csv) — enrichment for advanced stats
4. Legacy (results.csv, player_stats.csv) — backward compatibility
"""

from __future__ import annotations

import csv
import logging
from collections.abc import Callable
from pathlib import Path

import psycopg

from afl_mcp.core.db import get_admin_connection

__all__ = ["load_all", "check_freshness"]

logger = logging.getLogger(__name__)

TEAM_NAME_MAP: dict[str, str] = {
    "Greater Western Sydney": "GWS Giants",
    "GWS": "GWS Giants",
    "GWS GIANTS": "GWS Giants",
    "Brisbane Bears": "Brisbane Lions",
    "Brisbane": "Brisbane Lions",
    "Footscray": "Western Bulldogs",
    "Sydney Swans": "Sydney",
    "Geelong Cats": "Geelong",
    "Adelaide Crows": "Adelaide",
    "West Coast Eagles": "West Coast",
    "Gold Coast SUNS": "Gold Coast",
}

VENUE_NAME_MAP: dict[str, str] = {
    "M.C.G.": "MCG",
    "S.C.G.": "SCG",
    "Docklands": "Marvel Stadium",
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

AFL_RESULTS_COLUMN_MAP: dict[str, str] = {
    "match.matchId": "external_afl_id",
    "match.date": "Date",
    "match.homeTeam.name": "Home.Team",
    "match.awayTeam.name": "Away.Team",
    "venue.name": "Venue",
    "round.name": "Round",
    "round.roundNumber": "Round.Number",
    "homeTeamScore.matchScore.goals": "Home.Goals",
    "homeTeamScore.matchScore.behinds": "Home.Behinds",
    "homeTeamScore.matchScore.totalScore": "Home.Points",
    "awayTeamScore.matchScore.goals": "Away.Goals",
    "awayTeamScore.matchScore.behinds": "Away.Behinds",
    "awayTeamScore.matchScore.totalScore": "Away.Points",
}

AFL_STATS_COLUMN_MAP: dict[str, str] = {
    "providerId": "match_afl_id",
    "utcStartTime": "match_date",
    "home.team.name": "match_home_team",
    "away.team.name": "match_away_team",
    "venue.name": "venue_name",
    "team.name": "player_team",
    "player.player.player.playerId": "player_id",
    "player.player.player.givenName": "player_first_name",
    "player.player.player.surname": "player_last_name",
    "player.jumperNumber": "guernsey_number",
    "player.player.player.playerJumperNumber": "guernsey_number_alt",
    "player.player.position": "player_position",
    "timeOnGroundPercentage": "time_on_ground_percentage",
    "kicks": "kicks",
    "handballs": "handballs",
    "disposals": "disposals",
    "marks": "marks",
    "bounces": "bounces",
    "tackles": "tackles",
    "contestedPossessions": "contested_possessions",
    "uncontestedPossessions": "uncontested_possessions",
    "goals": "goals",
    "behinds": "behinds",
    "goalAssists": "goal_assists",
    "shotsAtGoal": "shots_at_goal",
    "scoreInvolvements": "score_involvements",
    "clearances.centreClearances": "centre_clearances",
    "clearances.stoppageClearances": "stoppage_clearances",
    "clearances.totalClearances": "clearances",
    "contestedMarks": "contested_marks",
    "marksInside50": "marks_inside_fifty",
    "onePercenters": "one_percenters",
    "clangers": "clangers",
    "freesFor": "free_kicks_for",
    "freesAgainst": "free_kicks_against",
    "hitouts": "hitouts",
    "inside50s": "inside_fifties",
    "rebound50s": "rebounds",
    "turnovers": "turnovers",
    "intercepts": "intercepts",
    "metresGained": "metres_gained",
    "tacklesInside50": "tackles_inside_fifty",
    "disposalEfficiency": "disposal_efficiency_percentage",
    "dreamTeamPoints": "afl_fantasy_score",
    "ratingPoints": "rating_points",
    "extendedStats.effectiveKicks": "effective_kicks",
    "extendedStats.effectiveDisposals": "effective_disposals",
    "extendedStats.marksOnLead": "marks_on_lead",
    "extendedStats.interceptMarks": "intercept_marks",
    "extendedStats.hitoutsToAdvantage": "hitouts_to_advantage",
    "extendedStats.hitoutWinPercentage": "hitout_win_percentage",
    "extendedStats.groundBallGets": "ground_ball_gets",
    "extendedStats.f50GroundBallGets": "f50_ground_ball_gets",
    "extendedStats.scoreLaunches": "score_launches",
    "extendedStats.pressureActs": "pressure_acts",
    "extendedStats.defHalfPressureActs": "def_half_pressure_acts",
    "extendedStats.spoils": "spoils",
    "extendedStats.ruckContests": "ruck_contests",
    "extendedStats.contestDefOneOnOnes": "contest_def_one_on_ones",
    "extendedStats.contestDefLosses": "contest_def_losses",
    "extendedStats.contestOffOneOnOnes": "contest_off_one_on_ones",
    "extendedStats.contestOffWins": "contest_off_wins",
}

FOOTYWIRE_RESULTS_COLUMN_MAP: dict[str, str] = {
    "Date": "Date",
    "Home.Team": "Home.Team",
    "Away.Team": "Away.Team",
    "Venue": "Venue",
    "Round": "Round",
    "Home.Points": "Home.Points",
    "Away.Points": "Away.Points",
    "Time": "Time",
}


def _remap_columns(
    rows: list[dict[str, str]], column_map: dict[str, str]
) -> list[dict[str, str]]:
    """Remap column names in CSV rows using a column map.

    Only columns present in the map are included in the output.
    Columns not in the map are dropped.

    Args:
        rows: List of row dicts with original column names.
        column_map: Mapping from source column names to target names.

    Returns:
        List of row dicts with remapped column names.
    """
    return [
        {dst: row[src] for src, dst in column_map.items() if src in row} for row in rows
    ]


def _normalise_team(name: str) -> str:
    """Normalise a team name to its canonical form.

    Strips leading/trailing whitespace before lookup.

    Args:
        name: Raw team name from CSV.

    Returns:
        Canonical team name.
    """
    name = name.strip()
    return TEAM_NAME_MAP.get(name, name)


def _normalise_venue(name: str) -> str:
    """Normalise a venue name to its canonical form.

    Strips leading/trailing whitespace before lookup (FootyWire has
    leading spaces in venue names).

    Args:
        name: Raw venue name from CSV.

    Returns:
        Canonical venue name.
    """
    name = name.strip()
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


_ParseFn = Callable[[str], int | float | str | None]

FRYZIGG_ENRICHMENT_COLUMNS: list[tuple[str, str, _ParseFn]] = [
    ("pressure_acts", "pressure_acts", _int_or_none),
    ("def_half_pressure_acts", "def_half_pressure_acts", _int_or_none),
    ("metres_gained", "metres_gained", _int_or_none),
    ("contest_def_losses", "contest_def_losses", _int_or_none),
    ("contest_def_one_on_ones", "contest_def_one_on_ones", _int_or_none),
    ("contest_off_one_on_ones", "contest_off_one_on_ones", _int_or_none),
    ("contest_off_wins", "contest_off_wins", _int_or_none),
    ("effective_kicks", "effective_kicks", _int_or_none),
    ("ground_ball_gets", "ground_ball_gets", _int_or_none),
    ("f50_ground_ball_gets", "f50_ground_ball_gets", _int_or_none),
    ("intercept_marks", "intercept_marks", _int_or_none),
    ("marks_on_lead", "marks_on_lead", _int_or_none),
    ("score_launches", "score_launches", _int_or_none),
    ("hitouts_to_advantage", "hitouts_to_advantage", _int_or_none),
    ("hitout_win_percentage", "hitout_win_pct", _float_or_none),
    ("ruck_contests", "ruck_contests", _int_or_none),
    ("spoils", "spoils", _int_or_none),
    ("effective_disposals", "effective_disposals", _int_or_none),
    ("rating_points", "rating_points", _float_or_none),
]


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
        results: Rows from results CSV (any source).
        stats_data: Rows from player_stats CSV (any source).

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
        results: Rows from results CSV (any source).
        stats_data: Rows from player_stats CSV (any source).
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
    """Load unique seasons from results CSV.

    Args:
        conn: Database connection.
        results: Rows from results CSV (any source).
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


def _is_afl_api_id(pid: str) -> bool:
    """Check whether a player ID is from the AFL API (Champion Data format).

    AFL API player IDs use the ``CD_I`` prefix (e.g. ``CD_I291776``),
    while fryzigg/legacy IDs are bare numeric strings.
    """
    return pid.startswith("CD_I")


def _load_players(
    conn: psycopg.Connection[dict],
    stats_data: list[dict[str, str]],
) -> dict[str, int]:
    """Load unique players from player_stats CSV data.

    Uses a two-pass approach to handle incompatible ID systems:
    1. Upsert fryzigg/legacy players (bare numeric IDs) via external_id.
    2. Link AFL API players (CD_I IDs) to existing rows by name match,
       or insert new rows if no match is found.

    The returned mapping contains entries for **both** ID formats pointing
    to the same database row, so downstream enrichment works regardless
    of which source's ID is used for lookup.

    Args:
        conn: Database connection.
        stats_data: Rows from player_stats CSV (any source, mixed OK).

    Returns:
        Mapping of external player ID to database ID.
    """
    # Deduplicate rows per player ID, preferring rows with physical stats.
    seen: dict[str, dict[str, str]] = {}
    for row in stats_data:
        pid = row.get("player_id", "").strip()
        if not pid:
            continue
        if pid not in seen:
            seen[pid] = dict(row)
        else:
            if not seen[pid].get("player_height_cm") and row.get("player_height_cm"):
                seen[pid]["player_height_cm"] = row["player_height_cm"]
            if not seen[pid].get("player_weight_kg") and row.get("player_weight_kg"):
                seen[pid]["player_weight_kg"] = row["player_weight_kg"]

    mapping: dict[str, int] = {}

    # --- Pass 1: fryzigg / legacy players (bare numeric IDs) ---
    for pid, s in seen.items():
        if _is_afl_api_id(pid):
            continue
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

    # --- Pass 2: AFL API players (CD_I IDs) ---
    for pid, s in seen.items():
        if not _is_afl_api_id(pid):
            continue
        surname = s.get("player_last_name", "")
        first_name = s.get("player_first_name", "")
        if not surname:
            continue

        # Fast path: AFL ID already linked from a previous run.
        existing = conn.execute(
            """SELECT id FROM players
               WHERE external_afl_player_id = %s""",
            (pid,),
        ).fetchone()
        if existing is not None:
            mapping[pid] = existing["id"]
            continue

        # Check if CD_I ID was previously stored in external_id by mistake.
        misplaced = conn.execute(
            """SELECT id FROM players WHERE external_id = %s""",
            (pid,),
        ).fetchone()
        if misplaced is not None:
            # Fix the misplaced ID: move it to external_afl_player_id.
            conn.execute(
                """UPDATE players
                   SET external_afl_player_id = external_id,
                       external_id = NULL
                   WHERE id = %s AND external_afl_player_id IS NULL""",
                (misplaced["id"],),
            )
            mapping[pid] = misplaced["id"]
            continue

        # Try to find existing player by name.
        matches = conn.execute(
            """SELECT id, external_id FROM players
               WHERE LOWER(first_name) = LOWER(%s)
                 AND LOWER(surname) = LOWER(%s)""",
            (first_name, surname),
        ).fetchall()

        if len(matches) == 1:
            # Unique name match — link AFL API ID to existing row.
            db_id = matches[0]["id"]
            conn.execute(
                """UPDATE players SET external_afl_player_id = %s
                   WHERE id = %s AND external_afl_player_id IS NULL""",
                (pid, db_id),
            )
            mapping[pid] = db_id
        elif len(matches) > 1:
            # Ambiguous: multiple players with the same name.
            # Try to disambiguate using the team from the stats row.
            team_name = _normalise_team(s.get("player_team", ""))
            resolved_id: int | None = None
            for m in matches:
                existing_id = m["id"]
                recent = conn.execute(
                    """SELECT t.name FROM player_match_stats pms
                       JOIN teams t ON t.id = pms.team_id
                       WHERE pms.player_id = %s
                       ORDER BY pms.id DESC LIMIT 1""",
                    (existing_id,),
                ).fetchone()
                if recent and recent["name"] == team_name:
                    resolved_id = existing_id
                    break
            if resolved_id is not None:
                conn.execute(
                    """UPDATE players SET external_afl_player_id = %s
                       WHERE id = %s AND external_afl_player_id IS NULL""",
                    (pid, resolved_id),
                )
                mapping[pid] = resolved_id
            else:
                logger.warning(
                    "Ambiguous name match for AFL player %s (%s %s) — "
                    "inserting as new row",
                    pid,
                    first_name,
                    surname,
                )
                row = conn.execute(
                    """INSERT INTO players
                           (first_name, surname, external_afl_player_id,
                            height_cm, weight_kg, is_retired)
                       VALUES (%s, %s, %s, %s, %s, %s)
                       ON CONFLICT (external_afl_player_id)
                           WHERE external_afl_player_id IS NOT NULL
                           DO UPDATE SET
                               height_cm = COALESCE(EXCLUDED.height_cm, players.height_cm),
                               weight_kg = COALESCE(EXCLUDED.weight_kg, players.weight_kg)
                       RETURNING id""",
                    (
                        _str_or_none(first_name),
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
        else:
            # No existing player — insert with AFL API ID only.
            row = conn.execute(
                """INSERT INTO players
                       (first_name, surname, external_afl_player_id,
                        height_cm, weight_kg, is_retired)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (external_afl_player_id)
                       WHERE external_afl_player_id IS NOT NULL
                       DO UPDATE SET
                           first_name = EXCLUDED.first_name,
                           surname = EXCLUDED.surname,
                           height_cm = COALESCE(EXCLUDED.height_cm, players.height_cm),
                           weight_kg = COALESCE(EXCLUDED.weight_kg, players.weight_kg),
                           is_retired = EXCLUDED.is_retired
                   RETURNING id""",
                (
                    _str_or_none(first_name),
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

    # Build unified map: also include fryzigg IDs for players matched by AFL ID.
    # Query all players that have both IDs and add cross-references.
    cross_linked = conn.execute(
        """SELECT id, external_id, external_afl_player_id FROM players
           WHERE external_id IS NOT NULL
             AND external_afl_player_id IS NOT NULL""",
    ).fetchall()
    for p in cross_linked:
        mapping[p["external_id"]] = p["id"]
        mapping[p["external_afl_player_id"]] = p["id"]

    return mapping


def _load_matches(
    conn: psycopg.Connection[dict],
    results: list[dict[str, str]],
    season_map: dict[int, int],
    team_map: dict[str, int],
    venue_map: dict[str, int],
) -> int:
    """Load matches from afltables results.csv (legacy path).

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


def _load_matches_from_afl(
    conn: psycopg.Connection[dict],
    results: list[dict[str, str]],
    season_map: dict[int, int],
    team_map: dict[str, int],
    venue_map: dict[str, int],
) -> int:
    """Load matches from AFL API results_afl.csv.

    Upserts on (date, home_team_id, away_team_id) and stores external_afl_id.
    AFL API dates may include a time component, so only the first 10
    characters (YYYY-MM-DD) are used.

    Args:
        conn: Database connection.
        results: Remapped rows from results_afl.csv.
        season_map: Year to season ID mapping.
        team_map: Team name to team ID mapping.
        venue_map: Venue name to venue ID mapping.

    Returns:
        Number of matches loaded.
    """
    count = 0
    for r in results:
        date = _str_or_none(r.get("Date", ""))
        if not date:
            continue
        date = date[:10]

        year = int(date[:4])
        season_id = season_map.get(year)
        if season_id is None:
            continue

        home_team = _normalise_team(r.get("Home.Team", ""))
        away_team = _normalise_team(r.get("Away.Team", ""))
        venue_name = _normalise_venue(r.get("Venue", ""))
        external_afl_id = _str_or_none(r.get("external_afl_id", ""))

        home_team_id = team_map.get(home_team)
        away_team_id = team_map.get(away_team)
        if not home_team_id or not away_team_id:
            continue

        conn.execute(
            """INSERT INTO matches (season_id, round, round_number, date,
                                    venue_id, home_team_id, away_team_id,
                                    home_goals, home_behinds, home_points,
                                    away_goals, away_behinds, away_points,
                                    external_afl_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (date, home_team_id, away_team_id) DO UPDATE SET
                   home_goals = EXCLUDED.home_goals,
                   home_behinds = EXCLUDED.home_behinds,
                   home_points = EXCLUDED.home_points,
                   away_goals = EXCLUDED.away_goals,
                   away_behinds = EXCLUDED.away_behinds,
                   away_points = EXCLUDED.away_points,
                   external_afl_id = COALESCE(EXCLUDED.external_afl_id, matches.external_afl_id)""",
            (
                season_id,
                r.get("Round", ""),
                _int_or_none(r.get("Round.Number", "")),
                date,
                venue_map.get(venue_name),
                home_team_id,
                away_team_id,
                _int_or_none(r.get("Home.Goals", "")),
                _int_or_none(r.get("Home.Behinds", "")),
                _int_or_none(r.get("Home.Points", "")),
                _int_or_none(r.get("Away.Goals", "")),
                _int_or_none(r.get("Away.Behinds", "")),
                _int_or_none(r.get("Away.Points", "")),
                external_afl_id,
            ),
        )
        count += 1

    conn.commit()
    return count


def _load_matches_from_footywire(
    conn: psycopg.Connection[dict],
    results: list[dict[str, str]],
    season_map: dict[int, int],
    team_map: dict[str, int],
    venue_map: dict[str, int],
) -> int:
    """Load matches from FootyWire results_footywire.csv.

    Inserts only matches not already present (uses tuple key for dedup).

    Args:
        conn: Database connection.
        results: Rows from results_footywire.csv.
        season_map: Year to season ID mapping.
        team_map: Team name to team ID mapping.
        venue_map: Venue name to venue ID mapping.

    Returns:
        Number of matches loaded.
    """
    count = 0
    for r in results:
        date = _str_or_none(r.get("Date", ""))
        if not date:
            continue
        date = date[:10]

        year = int(date[:4])
        season_id = season_map.get(year)
        if season_id is None:
            continue

        home_team = _normalise_team(r.get("Home.Team", ""))
        away_team = _normalise_team(r.get("Away.Team", ""))
        venue_name = _normalise_venue(r.get("Venue", ""))

        home_team_id = team_map.get(home_team)
        away_team_id = team_map.get(away_team)
        if not home_team_id or not away_team_id:
            continue

        home_points = _int_or_none(r.get("Home.Points", ""))
        away_points = _int_or_none(r.get("Away.Points", ""))
        margin = None
        if home_points is not None and away_points is not None:
            margin = home_points - away_points

        conn.execute(
            """INSERT INTO matches (season_id, round, date,
                                    venue_id, home_team_id, away_team_id,
                                    home_goals, home_behinds, home_points,
                                    away_goals, away_behinds, away_points,
                                    margin)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (date, home_team_id, away_team_id) DO NOTHING""",
            (
                season_id,
                r.get("Round", ""),
                date,
                venue_map.get(venue_name),
                home_team_id,
                away_team_id,
                _int_or_none(r.get("Home.Goals", "")),
                _int_or_none(r.get("Home.Behinds", "")),
                home_points,
                _int_or_none(r.get("Away.Goals", "")),
                _int_or_none(r.get("Away.Behinds", "")),
                away_points,
                margin,
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
    external ID, matched by date and home/away team. If the initial
    lookup fails, retries with swapped home/away teams since sources
    sometimes disagree on which team is home.

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

    Both orderings of (home, away) are indexed since data sources
    sometimes disagree on which team is home.

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
        lookup[(date_str, r["away_team"], r["home_team"])] = r["id"]
    return lookup


_PMS_COLUMNS: list[tuple[str, str, _ParseFn]] = [
    ("guernsey_number", "guernsey_number", _int_or_none),
    ("player_position", "player_position", _str_or_none),
    ("subbed", "subbed", _str_or_none),
    ("time_on_ground_percentage", "time_on_ground_pct", _float_or_none),
    ("kicks", "kicks", _int_or_none),
    ("handballs", "handballs", _int_or_none),
    ("disposals", "disposals", _int_or_none),
    ("effective_disposals", "effective_disposals", _int_or_none),
    ("disposal_efficiency_percentage", "disposal_efficiency_pct", _float_or_none),
    ("marks", "marks", _int_or_none),
    ("bounces", "bounces", _int_or_none),
    ("tackles", "tackles", _int_or_none),
    ("one_percenters", "one_percenters", _int_or_none),
    ("clangers", "clangers", _int_or_none),
    ("contested_possessions", "contested_possessions", _int_or_none),
    ("uncontested_possessions", "uncontested_possessions", _int_or_none),
    ("goals", "goals", _int_or_none),
    ("behinds", "behinds", _int_or_none),
    ("goal_assists", "goal_assists", _int_or_none),
    ("shots_at_goal", "shots_at_goal", _int_or_none),
    ("score_involvements", "score_involvements", _int_or_none),
    ("score_launches", "score_launches", _int_or_none),
    ("centre_clearances", "centre_clearances", _int_or_none),
    ("stoppage_clearances", "stoppage_clearances", _int_or_none),
    ("clearances", "clearances", _int_or_none),
    ("contested_marks", "contested_marks", _int_or_none),
    ("marks_inside_fifty", "marks_inside_fifty", _int_or_none),
    ("intercept_marks", "intercept_marks", _int_or_none),
    ("marks_on_lead", "marks_on_lead", _int_or_none),
    ("free_kicks_for", "free_kicks_for", _int_or_none),
    ("free_kicks_against", "free_kicks_against", _int_or_none),
    ("hitouts", "hitouts", _int_or_none),
    ("hitouts_to_advantage", "hitouts_to_advantage", _int_or_none),
    ("hitout_win_percentage", "hitout_win_pct", _float_or_none),
    ("ruck_contests", "ruck_contests", _int_or_none),
    ("inside_fifties", "inside_fifties", _int_or_none),
    ("rebounds", "rebounds", _int_or_none),
    ("turnovers", "turnovers", _int_or_none),
    ("intercepts", "intercepts", _int_or_none),
    ("metres_gained", "metres_gained", _int_or_none),
    ("pressure_acts", "pressure_acts", _int_or_none),
    ("def_half_pressure_acts", "def_half_pressure_acts", _int_or_none),
    ("tackles_inside_fifty", "tackles_inside_fifty", _int_or_none),
    ("spoils", "spoils", _int_or_none),
    ("contest_def_losses", "contest_def_losses", _int_or_none),
    ("contest_def_one_on_ones", "contest_def_one_on_ones", _int_or_none),
    ("contest_off_one_on_ones", "contest_off_one_on_ones", _int_or_none),
    ("contest_off_wins", "contest_off_wins", _int_or_none),
    ("effective_kicks", "effective_kicks", _int_or_none),
    ("ground_ball_gets", "ground_ball_gets", _int_or_none),
    ("f50_ground_ball_gets", "f50_ground_ball_gets", _int_or_none),
    ("brownlow_votes", "brownlow_votes", _int_or_none),
    ("rating_points", "rating_points", _float_or_none),
    ("afl_fantasy_score", "afl_fantasy_score", _int_or_none),
    ("supercoach_score", "supercoach_score", _int_or_none),
]

# Pre-build SQL from column list to keep it maintainable and aligned.
_PMS_DB_COLS = [db_col for _, db_col, _ in _PMS_COLUMNS]
_PMS_INSERT_SQL = (
    "INSERT INTO player_match_stats (match_id, player_id, team_id, "
    + ", ".join(_PMS_DB_COLS)
    + ") VALUES ("
    + ", ".join(["%s"] * (3 + len(_PMS_DB_COLS)))
    + ") ON CONFLICT (match_id, player_id) DO UPDATE SET "
    + ", ".join(f"{col} = EXCLUDED.{col}" for col in ["team_id", *_PMS_DB_COLS])
)


def _load_player_match_stats(
    conn: psycopg.Connection[dict],
    stats_data: list[dict[str, str]],
    player_map: dict[str, int],
    team_map: dict[str, int],
    match_lookup: dict[tuple[str, str, str], int] | None = None,
) -> int:
    """Load player match stats from player_stats CSV (fryzigg format).

    Args:
        conn: Database connection.
        stats_data: Rows from player_stats.csv (fryzigg column names).
        player_map: External player ID to database ID mapping.
        team_map: Team name to team ID mapping.
        match_lookup: Pre-built lookup, or None to build one.

    Returns:
        Number of stat rows loaded.
    """
    count = 0
    if match_lookup is None:
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

        stat_values = [
            parser(s.get(csv_col, ""))
            for csv_col, _, parser in _PMS_COLUMNS
        ]

        conn.execute(
            _PMS_INSERT_SQL,  # type: ignore[arg-type]
            (match_id, player_id, team_id, *stat_values),
        )
        count += 1

        if count % 5000 == 0:
            conn.commit()

    conn.commit()
    return count


def _enrich_from_fryzigg(
    conn: psycopg.Connection[dict],
    stats_data: list[dict[str, str]],
    player_map: dict[str, int],
    team_map: dict[str, int],
    match_lookup: dict[tuple[str, str, str], int] | None = None,
) -> int:
    """Enrich existing player_match_stats with fryzigg advanced columns.

    Only updates columns that are NULL in the existing row (COALESCE semantics).

    Args:
        conn: Database connection.
        stats_data: Rows from player_stats_fryzigg.csv.
        player_map: External player ID to database ID mapping.
        team_map: Team name to team ID mapping.
        match_lookup: Pre-built lookup, or None to build one.

    Returns:
        Number of rows enriched.
    """
    if match_lookup is None:
        match_lookup = _build_match_lookup(conn)
    count = 0

    # Pre-validate db_col values against known column names to prevent
    # SQL injection if FRYZIGG_ENRICHMENT_COLUMNS is ever populated from
    # external config. All values must be simple identifiers.
    _VALID_ENRICHMENT_DB_COLS = {db_col for _, db_col, _ in FRYZIGG_ENRICHMENT_COLUMNS}
    for _, db_col, _ in FRYZIGG_ENRICHMENT_COLUMNS:
        if not db_col.isidentifier():
            raise ValueError(f"Invalid enrichment column name: {db_col!r}")

    # Pre-build the SET clause once since it's the same for every row.
    set_clauses = [
        f"{db_col} = COALESCE({db_col}, %s)"
        for _, db_col, _ in FRYZIGG_ENRICHMENT_COLUMNS
    ]
    enrichment_sql = (
        f"UPDATE player_match_stats SET {', '.join(set_clauses)}"
        " WHERE match_id = %s AND player_id = %s"
    )

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

        values: list[int | float | None] = [
            parser(s.get(csv_col, ""))
            for csv_col, _, parser in FRYZIGG_ENRICHMENT_COLUMNS
        ]
        values.extend([match_id, player_id])
        conn.execute(enrichment_sql, values)  # type: ignore[arg-type]
        count += 1

        if count % 5000 == 0:
            conn.commit()

    conn.commit()
    return count


def _detect_source_files(data_dir: Path) -> dict[str, Path]:
    """Detect which source files are present in the data directory.

    Args:
        data_dir: Path to directory containing CSV files.

    Returns:
        Dict mapping source keys to file paths.
    """
    files: dict[str, Path] = {}

    candidates = {
        "results_afl": "results_afl.csv",
        "results_footywire": "results_footywire.csv",
        "results_legacy": "results.csv",
        "stats_afl": "player_stats_afl.csv",
        "stats_fryzigg": "player_stats_fryzigg.csv",
        "stats_legacy": "player_stats.csv",
    }

    for key, filename in candidates.items():
        path = data_dir / filename
        if path.exists():
            files[key] = path

    return files


def _resolve_sources(
    sources: dict[str, Path],
) -> tuple[
    list[dict[str, str]],
    list[dict[str, str]],
    list[dict[str, str]] | None,
    str | None,
]:
    """Read and remap CSV data from detected source files.

    Selects the highest-priority source for results and stats,
    applies column remapping for AFL API sources, and loads
    fryzigg data separately for enrichment.

    Args:
        sources: Mapping of source keys to file paths from
            ``_detect_source_files``.

    Returns:
        A tuple of (results_data, stats_data, fryzigg_data,
        results_source) where results_source is ``"afl"``,
        ``"footywire"``, ``"legacy"``, or ``None``.
    """
    results_data: list[dict[str, str]] = []
    stats_data: list[dict[str, str]] = []
    fryzigg_data: list[dict[str, str]] | None = None
    results_source: str | None = None

    if "results_afl" in sources:
        raw = _read_csv(sources["results_afl"])
        results_data = _remap_columns(raw, AFL_RESULTS_COLUMN_MAP)
        results_source = "afl"
        logger.info("Using AFL API results (%d rows)", len(results_data))
    elif "results_footywire" in sources:
        results_data = _read_csv(sources["results_footywire"])
        results_source = "footywire"
        logger.info("Using FootyWire results (%d rows)", len(results_data))
    elif "results_legacy" in sources:
        results_data = _read_csv(sources["results_legacy"])
        results_source = "legacy"
        logger.info("Using legacy results (%d rows)", len(results_data))

    if "stats_afl" in sources:
        raw = _read_csv(sources["stats_afl"])
        stats_data = _remap_columns(raw, AFL_STATS_COLUMN_MAP)
        logger.info("Using AFL API player stats (%d rows)", len(stats_data))
    elif "stats_legacy" in sources:
        stats_data = _read_csv(sources["stats_legacy"])
        logger.info("Using legacy player stats (%d rows)", len(stats_data))

    if "stats_fryzigg" in sources:
        fryzigg_data = _read_csv(sources["stats_fryzigg"])
        logger.info("Fryzigg enrichment data available (%d rows)", len(fryzigg_data))

    return results_data, stats_data, fryzigg_data, results_source


def _load_matches_by_priority(
    conn: psycopg.Connection[dict],
    results_source: str | None,
    results_data: list[dict[str, str]],
    sources: dict[str, Path],
    season_map: dict[int, int],
    team_map: dict[str, int],
    venue_map: dict[str, int],
) -> dict[str, int]:
    """Load matches using the appropriate loader for the detected source.

    AFL API results take priority, with FootyWire loaded as a supplement
    when both are present. FootyWire-only and legacy paths are also
    handled.

    Args:
        conn: Database connection.
        results_source: Which source provided results.
        results_data: Rows from the primary results CSV.
        sources: Full source file mapping for supplemental reads.
        season_map: Year to season ID mapping.
        team_map: Team name to team ID mapping.
        venue_map: Venue name to venue ID mapping.

    Returns:
        Dict of count keys to row counts for match loading.
    """
    counts: dict[str, int] = {}

    if results_source == "afl":
        counts["matches"] = _load_matches_from_afl(
            conn, results_data, season_map, team_map, venue_map
        )
        if "results_footywire" in sources:
            fw_data = _read_csv(sources["results_footywire"])
            counts["matches_footywire_supplement"] = _load_matches_from_footywire(
                conn, fw_data, season_map, team_map, venue_map
            )
    elif results_source == "footywire":
        counts["matches"] = _load_matches_from_footywire(
            conn, results_data, season_map, team_map, venue_map
        )
    else:
        counts["matches"] = _load_matches(
            conn, results_data, season_map, team_map, venue_map
        )

    return counts


def load_all(data_dir: str | Path) -> dict[str, int]:
    """Load all CSV data into the database.

    Auto-detects source files by filename pattern and loads in priority order:
    1. AFL API results, then FootyWire results, then legacy afltables results
    2. AFL API player stats, then legacy fryzigg player stats
    3. Fryzigg enrichment if both AFL stats and fryzigg stats are present

    Falls back to legacy behavior if only results.csv + player_stats.csv exist.

    Args:
        data_dir: Path to directory containing the CSV files.

    Returns:
        Dict mapping table name to number of rows loaded.
    """
    data_dir = Path(data_dir)
    counts: dict[str, int] = {}
    sources = _detect_source_files(data_dir)
    logger.info("Detected source files: %s", list(sources.keys()))

    results_data, stats_data, fryzigg_data, results_source = _resolve_sources(sources)

    if not results_data:
        logger.warning("No results CSV found in %s", data_dir)
        return counts

    with get_admin_connection() as conn:
        competition_id = _ensure_competition(conn)
        all_stats = stats_data + fryzigg_data if fryzigg_data else stats_data

        venue_map = _load_venues(conn, results_data, all_stats)
        counts["venues"] = len(venue_map)
        conn.commit()

        team_map = _load_teams(conn, results_data, all_stats, competition_id)
        counts["teams"] = len(team_map)
        conn.commit()

        season_map = _load_seasons(conn, results_data, competition_id)
        counts["seasons"] = len(season_map)
        conn.commit()

        player_map = _load_players(conn, all_stats)
        counts["players"] = len(player_map)
        conn.commit()

        match_counts = _load_matches_by_priority(
            conn,
            results_source,
            results_data,
            sources,
            season_map,
            team_map,
            venue_map,
        )
        counts.update(match_counts)

        if fryzigg_data:
            enriched = _enrich_matches_from_stats(conn, fryzigg_data, team_map)
            counts["matches_enriched"] = enriched
        elif "stats_afl" not in sources:
            enriched = _enrich_matches_from_stats(conn, stats_data, team_map)
            counts["matches_enriched"] = enriched

        match_lookup = _build_match_lookup(conn)

        stats_count = _load_player_match_stats(
            conn, stats_data, player_map, team_map, match_lookup
        )
        counts["player_match_stats"] = stats_count

        if fryzigg_data and "stats_afl" in sources:
            enrich_count = _enrich_from_fryzigg(
                conn, fryzigg_data, player_map, team_map, match_lookup
            )
            counts["fryzigg_enrichment"] = enrich_count

    logger.info("Load complete: %s", counts)
    return counts


def check_freshness(data_dir: str | Path) -> dict[str, object]:
    """Compare extracted CSV data against the database to detect new matches.

    Reads the highest-priority results CSV, finds its latest match date,
    and compares against the most recent match date in the database.
    Also compares match counts per season to detect gaps where the DB
    is missing matches on dates it already covers (e.g. a game added
    to the source after later games were already loaded).

    Args:
        data_dir: Path to directory containing the CSV files.

    Returns:
        Dict with ``has_new_data`` (bool), ``csv_latest_date``,
        ``db_latest_date``, and ``reason`` (human-readable explanation).
    """
    from afl_mcp.core.db import get_pool  # noqa: F811

    data_dir = Path(data_dir)
    sources = _detect_source_files(data_dir)

    if not sources:
        return {
            "has_new_data": False,
            "csv_latest_date": None,
            "db_latest_date": None,
            "reason": "No CSV files found",
        }

    results_data, _, _, _ = _resolve_sources(sources)

    if not results_data:
        return {
            "has_new_data": False,
            "csv_latest_date": None,
            "db_latest_date": None,
            "reason": "No results CSV found",
        }

    csv_dates = [r["Date"][:10] for r in results_data if r.get("Date")]
    csv_latest = max(csv_dates) if csv_dates else None

    if not csv_latest:
        return {
            "has_new_data": False,
            "csv_latest_date": None,
            "db_latest_date": None,
            "reason": "No dates found in CSV",
        }

    # Count CSV matches per season year for gap detection.
    csv_counts_by_year: dict[str, int] = {}
    for d in csv_dates:
        year = d[:4]
        csv_counts_by_year[year] = csv_counts_by_year.get(year, 0) + 1

    pool = get_pool()
    with pool.connection() as conn:
        row = conn.execute("SELECT MAX(date) AS max_date FROM matches").fetchone()
        db_max = row["max_date"] if row else None
        db_latest = str(db_max) if db_max else None

        # Fetch DB match counts per season year for comparison.
        db_counts_by_year: dict[str, int] = {}
        if db_latest is not None:
            year_rows = conn.execute(
                """SELECT EXTRACT(YEAR FROM m.date)::text AS year,
                          COUNT(*) AS cnt
                   FROM matches m
                   GROUP BY 1"""
            ).fetchall()
            for yr in year_rows:
                db_counts_by_year[yr["year"]] = yr["cnt"]

    if db_latest is None:
        return {
            "has_new_data": True,
            "csv_latest_date": csv_latest,
            "db_latest_date": None,
            "reason": "Database is empty",
        }

    # Primary check: CSV has matches on a newer date.
    if csv_latest > db_latest:
        return {
            "has_new_data": True,
            "csv_latest_date": csv_latest,
            "db_latest_date": db_latest,
            "reason": f"CSV has matches up to {csv_latest}, DB only has up to {db_latest}",
        }

    # Secondary check: CSV has more matches than DB for any season year.
    # This catches gaps where the DB is missing matches on dates it already
    # covers (e.g. a game that appeared in the source after later games
    # were loaded, so the date-only check would miss it).
    for year, csv_count in csv_counts_by_year.items():
        db_count = db_counts_by_year.get(year, 0)
        if csv_count > db_count:
            return {
                "has_new_data": True,
                "csv_latest_date": csv_latest,
                "db_latest_date": db_latest,
                "reason": (
                    f"CSV has {csv_count} matches for {year} but DB only has "
                    f"{db_count} (latest date {db_latest})"
                ),
            }

    return {
        "has_new_data": False,
        "csv_latest_date": csv_latest,
        "db_latest_date": db_latest,
        "reason": f"DB is up to date ({db_latest})",
    }
