"""Tests for embedding summary generation functions.

Tests the pure text-generation functions in embeddings.py that build
natural language summaries from aggregated stat dicts. These require
no database or model — they are string formatting functions.
"""

from __future__ import annotations

import pytest

from afl_mcp.core.embeddings import _build_match_summary, _build_player_season_summary


class TestBuildPlayerSeasonSummary:
    """Verify player season summary text generation."""

    def _make_row(self, **overrides: object) -> dict:
        """Build a base player season row with sensible defaults.

        Args:
            **overrides: Fields to override in the default row.

        Returns:
            A dict mimicking the aggregation query result.
        """
        base: dict = {
            "first_name": "Patrick",
            "surname": "Cripps",
            "team_name": "Carlton",
            "year": 2023,
            "matches_played": 22,
            "avg_disposals": 28.5,
            "avg_kicks": 12.3,
            "avg_marks": 4.1,
            "avg_tackles": 6.7,
            "total_goals": 15,
            "avg_supercoach": 112.4,
        }
        base.update(overrides)
        return base

    def test_includes_player_name_and_team(self) -> None:
        """Summary contains the player's name, team, and year."""
        result = _build_player_season_summary(self._make_row())
        assert "Patrick Cripps" in result
        assert "Carlton" in result
        assert "2023" in result

    def test_includes_matches_played(self) -> None:
        """Summary states the number of matches played."""
        result = _build_player_season_summary(self._make_row())
        assert "22 matches" in result

    def test_includes_disposals(self) -> None:
        """Summary includes average disposals when present."""
        result = _build_player_season_summary(self._make_row())
        assert "28.5 disposals" in result

    def test_includes_goals_when_nonzero(self) -> None:
        """Summary mentions goals when the player kicked some."""
        result = _build_player_season_summary(self._make_row(total_goals=30))
        assert "30 goals" in result

    def test_omits_goals_when_zero(self) -> None:
        """Summary omits the goals line for players who kicked none."""
        result = _build_player_season_summary(self._make_row(total_goals=0))
        assert "goals" not in result.lower()

    def test_handles_none_stats_gracefully(self) -> None:
        """Summary works when optional stat fields are None."""
        row = self._make_row(
            avg_disposals=None,
            avg_kicks=None,
            avg_marks=None,
            avg_tackles=None,
            total_goals=None,
            avg_supercoach=None,
        )
        result = _build_player_season_summary(row)
        assert "Patrick Cripps" in result
        assert "22 matches" in result

    def test_includes_supercoach_average(self) -> None:
        """Summary includes SuperCoach average when present."""
        result = _build_player_season_summary(self._make_row())
        assert "112.4" in result
        assert "SuperCoach" in result


class TestBuildMatchSummary:
    """Verify match summary text generation."""

    def _make_row(self, **overrides: object) -> dict:
        """Build a base match row with sensible defaults.

        Args:
            **overrides: Fields to override in the default row.

        Returns:
            A dict mimicking the match summary query result.
        """
        base: dict = {
            "round": "R5",
            "round_number": 5,
            "year": 2023,
            "home_team": "Melbourne",
            "away_team": "Carlton",
            "home_points": 98,
            "away_points": 72,
            "margin": 26,
            "venue": "MCG",
        }
        base.update(overrides)
        return base

    def test_home_win_uses_def(self) -> None:
        """When home team wins, summary uses 'def.' phrasing."""
        result = _build_match_summary(self._make_row())
        assert "def." in result
        assert "Melbourne (98)" in result
        assert "Carlton (72)" in result

    def test_away_win_uses_lost_to(self) -> None:
        """When away team wins, summary uses 'lost to' phrasing."""
        result = _build_match_summary(
            self._make_row(home_points=60, away_points=90, margin=-30)
        )
        assert "lost to" in result

    def test_draw_uses_drew_with(self) -> None:
        """When scores are equal, summary uses 'drew with' phrasing."""
        result = _build_match_summary(
            self._make_row(home_points=80, away_points=80, margin=0)
        )
        assert "drew with" in result

    def test_includes_round_and_year(self) -> None:
        """Summary contains the round number and year."""
        result = _build_match_summary(self._make_row())
        assert "Round 5" in result
        assert "2023" in result

    def test_includes_venue(self) -> None:
        """Summary contains the venue name."""
        result = _build_match_summary(self._make_row())
        assert "MCG" in result

    def test_includes_margin(self) -> None:
        """Summary states the margin in points."""
        result = _build_match_summary(self._make_row())
        assert "26 points" in result

    def test_handles_none_margin(self) -> None:
        """Summary handles a None margin without crashing."""
        result = _build_match_summary(self._make_row(margin=None))
        assert "0 points" in result

    def test_uses_round_name_when_no_number(self) -> None:
        """Falls back to round name string when round_number is None."""
        result = _build_match_summary(
            self._make_row(round="QF", round_number=None)
        )
        assert "Round QF" in result
