"""Tests for fryzigg enrichment logic and multi-source column mapping."""

from __future__ import annotations

from afl_mcp.core.loader import (
    AFL_RESULTS_COLUMN_MAP,
    AFL_STATS_COLUMN_MAP,
    FOOTYWIRE_RESULTS_COLUMN_MAP,
    FRYZIGG_ENRICHMENT_COLUMNS,
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
