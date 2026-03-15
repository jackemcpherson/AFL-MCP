"""Tests for PAV (Player Approximate Value) calculation.

Tests the PAV module's formula validation, year constraints,
and SQL query structure. All tests mock the database.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from afl_mcp.core.pav import MIN_PAV_YEAR, _PAV_SQL, calculate_pav


class TestPavSql:
    """Verify the PAV SQL query contains all required components."""

    def test_contains_all_nine_ctes(self) -> None:
        """The query must include all 9 CTEs from the PAV formula."""
        expected_ctes = [
            "target_season",
            "team_match_i50",
            "team_season",
            "league_avg",
            "num_teams",
            "team_ratings",
            "team_ratings_full",
            "team_pavs",
            "player_match",
            "player_scores",
            "team_scores",
            "player_pavs",
        ]
        for cte in expected_ctes:
            assert cte in _PAV_SQL, f"Missing CTE: {cte}"

    def test_uses_parameterized_year(self) -> None:
        """The query uses a named parameter for the season year."""
        assert "%(year)s" in _PAV_SQL

    def test_uses_upsert(self) -> None:
        """The query upserts via ON CONFLICT."""
        assert "ON CONFLICT" in _PAV_SQL
        assert "DO UPDATE SET" in _PAV_SQL

    def test_filters_completed_matches(self) -> None:
        """Only completed matches are included."""
        assert "home_points IS NOT NULL" in _PAV_SQL

    def test_coalesces_nullable_stats(self) -> None:
        """All nullable stat columns use COALESCE."""
        stats = [
            "goals",
            "behinds",
            "hitouts",
            "goal_assists",
            "inside_fifties",
            "marks_inside_fifty",
            "free_kicks_for",
            "free_kicks_against",
            "rebounds",
            "one_percenters",
            "marks",
            "clearances",
            "tackles",
        ]
        for stat in stats:
            assert f"COALESCE(pms.{stat}" in _PAV_SQL, f"Missing COALESCE for {stat}"

    def test_offensive_formula_weights(self) -> None:
        """Offensive score uses correct weights from HPN guide."""
        assert "0.25 * hitouts" in _PAV_SQL
        assert "3.0 * goal_assists" in _PAV_SQL

    def test_defensive_formula_weights(self) -> None:
        """Defensive score uses correct weights from HPN guide."""
        assert "20.0 * rebounds" in _PAV_SQL
        assert "12.0 * one_percenters" in _PAV_SQL
        assert "4.0 * marks_inside_fifty" in _PAV_SQL
        assert "(2.0 / 3.0) * hitouts" in _PAV_SQL

    def test_midfield_formula_weights(self) -> None:
        """Midfield score uses correct weights from HPN guide."""
        assert "15.0 * inside_fifties" in _PAV_SQL
        assert "20.0 * clearances" in _PAV_SQL
        assert "3.0 * tackles" in _PAV_SQL
        assert "1.5 * hitouts" in _PAV_SQL

    def test_defence_rating_transform(self) -> None:
        """Defence rating uses the non-linear DN transform."""
        assert "2.0 * dn - dn * dn" in _PAV_SQL

    def test_filters_aflm_competition(self) -> None:
        """Only AFLM competition is included."""
        assert "'AFLM'" in _PAV_SQL

    def test_player_points_not_team_points(self) -> None:
        """Offensive score uses player goals*6+behinds, not team points."""
        assert "goals, 0) * 6" in _PAV_SQL


class TestCalculatePav:
    """Verify calculate_pav function behavior."""

    def test_rejects_pre_1998(self) -> None:
        """Years before 1998 raise ValueError."""
        with pytest.raises(ValueError, match="1998"):
            calculate_pav(1997)

    def test_accepts_1998(self) -> None:
        """1998 is the first supported year."""
        with patch("afl_mcp.core.pav.get_admin_connection") as mock_admin:
            mock_conn = MagicMock()
            mock_conn.execute.return_value.rowcount = 42
            mock_admin.return_value.__enter__ = MagicMock(return_value=mock_conn)
            mock_admin.return_value.__exit__ = MagicMock(return_value=False)

            count = calculate_pav(1998)

            assert count == 42
            mock_conn.execute.assert_called_once()
            sql, params = mock_conn.execute.call_args[0]
            assert params == {"year": 1998}

    def test_commits_after_execution(self) -> None:
        """The function commits the transaction."""
        with patch("afl_mcp.core.pav.get_admin_connection") as mock_admin:
            mock_conn = MagicMock()
            mock_conn.execute.return_value.rowcount = 10
            mock_admin.return_value.__enter__ = MagicMock(return_value=mock_conn)
            mock_admin.return_value.__exit__ = MagicMock(return_value=False)

            calculate_pav(2023)

            mock_conn.commit.assert_called_once()

    def test_min_pav_year_constant(self) -> None:
        """MIN_PAV_YEAR is set to 1998."""
        assert MIN_PAV_YEAR == 1998
