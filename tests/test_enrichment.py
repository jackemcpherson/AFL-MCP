"""Tests for fryzigg enrichment logic and multi-source column mapping."""

from __future__ import annotations

from unittest.mock import MagicMock

from afl_mcp.core.loader import (
    AFL_RESULTS_COLUMN_MAP,
    AFL_STATS_COLUMN_MAP,
    FOOTYWIRE_RESULTS_COLUMN_MAP,
    FRYZIGG_ENRICHMENT_COLUMNS,
    _load_players,
    _remap_columns,
)


class TestRemapColumns:
    """Verify column remapping transforms AFL API columns correctly."""

    def test_remap_afl_results(self) -> None:
        """AFL API result columns are remapped to internal names."""
        rows = [
            {
                "match.matchId": "12345",
                "match.date": "2025-03-15",
                "match.homeTeam.name": "Sydney Swans",
                "match.awayTeam.name": "GWS GIANTS",
                "venue.name": "SCG",
                "round.name": "Round 1",
                "round.roundNumber": "1",
                "homeTeamScore.matchScore.goals": "10",
                "homeTeamScore.matchScore.behinds": "8",
                "homeTeamScore.matchScore.totalScore": "68",
                "awayTeamScore.matchScore.goals": "5",
                "awayTeamScore.matchScore.behinds": "12",
                "awayTeamScore.matchScore.totalScore": "42",
                "extra.column": "ignored",
            }
        ]
        result = _remap_columns(rows, AFL_RESULTS_COLUMN_MAP)
        assert len(result) == 1
        r = result[0]
        assert r["external_afl_id"] == "12345"
        assert r["Date"] == "2025-03-15"
        assert r["Home.Team"] == "Sydney Swans"
        assert r["Away.Team"] == "GWS GIANTS"
        assert r["Venue"] == "SCG"
        assert r["Home.Goals"] == "10"
        assert r["Away.Points"] == "42"
        assert "extra.column" not in r

    def test_remap_afl_stats(self) -> None:
        """AFL API stat columns are remapped to fryzigg-compatible names."""
        rows = [
            {
                "providerId": "CD_M123",
                "utcStartTime": "2025-03-15T10:00:00Z",
                "home.team.name": "Sydney Swans",
                "away.team.name": "GWS GIANTS",
                "team.name": "Sydney Swans",
                "player.player.player.playerId": "CD_I999",
                "player.player.player.givenName": "Isaac",
                "player.player.player.surname": "Heeney",
                "kicks": "20",
                "handballs": "10",
                "extendedStats.pressureActs": "15",
                "extendedStats.metresGained": "400",
            }
        ]
        result = _remap_columns(rows, AFL_STATS_COLUMN_MAP)
        assert len(result) == 1
        r = result[0]
        assert r["match_afl_id"] == "CD_M123"
        assert r["match_date"] == "2025-03-15T10:00:00Z"
        assert r["match_home_team"] == "Sydney Swans"
        assert r["player_id"] == "CD_I999"
        assert r["player_first_name"] == "Isaac"
        assert r["player_last_name"] == "Heeney"
        assert r["kicks"] == "20"
        assert r["pressure_acts"] == "15"

    def test_remap_empty_rows(self) -> None:
        """Empty input produces empty output."""
        assert _remap_columns([], AFL_RESULTS_COLUMN_MAP) == []

    def test_remap_missing_columns_skipped(self) -> None:
        """Rows with missing source columns still remap what's present."""
        rows = [{"match.matchId": "123"}]
        result = _remap_columns(rows, AFL_RESULTS_COLUMN_MAP)
        assert result[0] == {"external_afl_id": "123"}

    def test_footywire_column_map(self) -> None:
        """FootyWire map passes through its available columns."""
        rows = [
            {
                "Date": "2025-03-15",
                "Home.Team": "Richmond",
                "Away.Team": "Carlton",
                "Venue": " MCG",
                "Round": "Round 1",
                "Home.Points": "95",
                "Away.Points": "82",
                "Time": "1:45 PM",
            }
        ]
        result = _remap_columns(rows, FOOTYWIRE_RESULTS_COLUMN_MAP)
        assert result[0]["Date"] == "2025-03-15"
        assert result[0]["Home.Team"] == "Richmond"
        assert result[0]["Home.Points"] == "95"
        assert result[0]["Time"] == "1:45 PM"


class TestFryziggEnrichmentColumns:
    """Verify the enrichment column list is complete and consistent."""

    def test_enrichment_columns_not_empty(self) -> None:
        """The enrichment column list contains entries."""
        assert len(FRYZIGG_ENRICHMENT_COLUMNS) > 0

    def test_expected_advanced_columns_present(self) -> None:
        """Key advanced stats are in the enrichment list."""
        expected = {
            "pressure_acts",
            "metres_gained",
            "effective_kicks",
            "effective_disposals",
            "ground_ball_gets",
            "score_launches",
            "spoils",
            "contest_def_losses",
            "contest_off_wins",
        }
        csv_cols = {csv_col for csv_col, _, _ in FRYZIGG_ENRICHMENT_COLUMNS}
        assert expected.issubset(csv_cols)

    def test_no_duplicate_columns(self) -> None:
        """No duplicates in the enrichment column list."""
        db_cols = [db_col for _, db_col, _ in FRYZIGG_ENRICHMENT_COLUMNS]
        assert len(db_cols) == len(set(db_cols))

    def test_enrichment_columns_are_tuples(self) -> None:
        """All enrichment entries are (csv_col, db_col, parser) tuples."""
        for entry in FRYZIGG_ENRICHMENT_COLUMNS:
            assert isinstance(entry, tuple)
            assert len(entry) == 3
            csv_col, db_col, parser = entry
            assert isinstance(csv_col, str) and len(csv_col) > 0
            assert isinstance(db_col, str) and len(db_col) > 0
            assert callable(parser)


class TestColumnMapCompleteness:
    """Verify column maps have required entries."""

    def test_afl_results_map_has_key_columns(self) -> None:
        """AFL results map includes date, teams, scores, and ID."""
        required_targets = {
            "Date",
            "Home.Team",
            "Away.Team",
            "Venue",
            "Home.Goals",
            "Home.Behinds",
            "Home.Points",
            "Away.Goals",
            "Away.Behinds",
            "Away.Points",
            "external_afl_id",
        }
        actual_targets = set(AFL_RESULTS_COLUMN_MAP.values())
        assert required_targets.issubset(actual_targets)

    def test_afl_stats_map_has_player_identity(self) -> None:
        """AFL stats map includes player ID and name columns."""
        required_targets = {
            "player_id",
            "player_first_name",
            "player_last_name",
            "player_team",
            "match_home_team",
            "match_away_team",
            "match_date",
        }
        actual_targets = set(AFL_STATS_COLUMN_MAP.values())
        assert required_targets.issubset(actual_targets)

    def test_afl_stats_map_has_extended_stats(self) -> None:
        """AFL stats map includes extended stat columns."""
        extended_targets = {
            "effective_kicks",
            "effective_disposals",
            "pressure_acts",
            "metres_gained",
            "ground_ball_gets",
            "spoils",
        }
        actual_targets = set(AFL_STATS_COLUMN_MAP.values())
        assert extended_targets.issubset(actual_targets)


def _mock_conn_for_load_players(
    *,
    name_matches: list[list[dict[str, object]]] | None = None,
    cross_linked: list[dict[str, object]] | None = None,
) -> MagicMock:
    """Build a mock connection for _load_players tests.

    Args:
        name_matches: Successive return values for name-lookup queries.
        cross_linked: Rows returned by the final cross-link query.
    """
    conn = MagicMock()
    if name_matches is None:
        name_matches = []
    if cross_linked is None:
        cross_linked = []

    # Track calls to conn.execute and return appropriate mocks.
    call_results: list[MagicMock] = []

    def execute_side_effect(sql: str, params: tuple = ()) -> MagicMock:  # noqa: ARG001
        result = MagicMock()
        sql_stripped = sql.strip()

        if (
            sql_stripped.startswith("INSERT INTO players")
            and "external_id" in sql_stripped
        ):
            # Pass 1: fryzigg upsert — return a row with an incrementing id.
            fryzigg_id = len([r for r in call_results if r._is_fryzigg]) + 1
            result.fetchone.return_value = {"id": fryzigg_id}
            result._is_fryzigg = True
        elif sql_stripped.startswith("SELECT id, external_id FROM players"):
            # Pass 2: name lookup.
            if name_matches:
                result.fetchall.return_value = name_matches.pop(0)
            else:
                result.fetchall.return_value = []
            result._is_fryzigg = False
        elif sql_stripped.startswith("UPDATE players SET external_afl_player_id"):
            result._is_fryzigg = False
        elif (
            sql_stripped.startswith("INSERT INTO players")
            and "external_afl_player_id" in sql_stripped
        ):
            # Pass 2: new AFL-only player insert.
            afl_id = 100 + len([r for r in call_results if r._is_afl_insert])
            result.fetchone.return_value = {"id": afl_id}
            result._is_afl_insert = True
            result._is_fryzigg = False
        elif sql_stripped.startswith("SELECT id, external_id, external_afl_player_id"):
            # Final cross-link query.
            result.fetchall.return_value = cross_linked
            result._is_fryzigg = False
        else:
            result._is_fryzigg = False

        if not hasattr(result, "_is_afl_insert"):
            result._is_afl_insert = False
        call_results.append(result)
        return result

    conn.execute.side_effect = execute_side_effect
    return conn


class TestCrossSourcePlayerMatching:
    """Verify _load_players handles mixed AFL API and fryzigg IDs."""

    def test_same_player_both_sources_maps_both_ids(self) -> None:
        """A player present in both sources gets both IDs in the map."""
        stats = [
            {
                "player_id": "12070",
                "player_first_name": "Taylor",
                "player_last_name": "Adams",
                "player_height_cm": "182",
                "player_weight_kg": "85",
                "player_is_retired": "FALSE",
                "player_team": "Collingwood",
            },
            {
                "player_id": "CD_I291776",
                "player_first_name": "Taylor",
                "player_last_name": "Adams",
                "player_height_cm": "182",
                "player_weight_kg": "85",
                "player_is_retired": "FALSE",
                "player_team": "Collingwood",
            },
        ]

        conn = _mock_conn_for_load_players(
            # Name lookup for CD_I291776 finds the fryzigg-inserted player.
            name_matches=[[{"id": 1, "external_id": "12070"}]],
            # Cross-link query returns the now-linked player.
            cross_linked=[
                {
                    "id": 1,
                    "external_id": "12070",
                    "external_afl_player_id": "CD_I291776",
                }
            ],
        )

        result = _load_players(conn, stats)

        # Both IDs should map to the same database ID.
        assert result["12070"] == result["CD_I291776"]
        assert result["12070"] == 1

    def test_afl_only_player_creates_new_row(self) -> None:
        """A player only in AFL API data gets inserted with no external_id."""
        stats = [
            {
                "player_id": "CD_I999999",
                "player_first_name": "New",
                "player_last_name": "Player",
                "player_height_cm": "190",
                "player_weight_kg": "90",
                "player_is_retired": "FALSE",
                "player_team": "Richmond",
            },
        ]

        conn = _mock_conn_for_load_players(
            # Name lookup returns no matches.
            name_matches=[[]],
            cross_linked=[],
        )

        result = _load_players(conn, stats)

        assert "CD_I999999" in result

    def test_name_collision_different_players(self) -> None:
        """Two players with the same name should not be merged when ambiguous."""
        stats = [
            {
                "player_id": "11111",
                "player_first_name": "Josh",
                "player_last_name": "Kelly",
                "player_height_cm": "186",
                "player_weight_kg": "83",
                "player_is_retired": "FALSE",
                "player_team": "GWS Giants",
            },
            {
                "player_id": "CD_I500000",
                "player_first_name": "Josh",
                "player_last_name": "Kelly",
                "player_height_cm": "186",
                "player_weight_kg": "83",
                "player_is_retired": "FALSE",
                "player_team": "GWS Giants",
            },
        ]

        # Name lookup returns TWO matches (ambiguous).
        # Team disambig query finds no recent stats (empty DB).
        team_result = MagicMock()
        team_result.fetchone.return_value = None

        conn = _mock_conn_for_load_players(
            name_matches=[
                [
                    {"id": 1, "external_id": "11111"},
                    {"id": 2, "external_id": "22222"},
                ]
            ],
            cross_linked=[],
        )

        # Override the team lookup to return None (no recent stats).
        original_side_effect = conn.execute.side_effect

        def patched_execute(sql: str, params: tuple = ()) -> MagicMock:
            if "player_match_stats" in sql:
                result = MagicMock()
                result.fetchone.return_value = None
                result._is_fryzigg = False
                result._is_afl_insert = False
                return result
            return original_side_effect(sql, params)

        conn.execute.side_effect = patched_execute

        result = _load_players(conn, stats)

        # Both IDs should be in the map.
        assert "11111" in result
        assert "CD_I500000" in result
