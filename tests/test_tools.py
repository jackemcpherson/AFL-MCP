"""Tests for high-level AFL statistics tools.

Verifies core tool functions build correct SQL and handle edge cases.
All tests mock execute_query to avoid needing a database.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from afl_mcp.core.tools import (
    TEAM_ALIAS_MAP,
    VALID_STAT_COLUMNS,
    _resolve_team_name,
    get_ladder,
    get_pav_leaders,
    get_player_pav,
    head_to_head,
    player_career_summary,
    player_comparison,
    search_matches,
    search_players,
    stat_leaders,
)

MOCK_EXECUTE = "afl_mcp.core.tools.execute_query"


# ---------------------------------------------------------------------------
# _resolve_team_name
# ---------------------------------------------------------------------------


class TestResolveTeamName:
    """Verify team alias resolution."""

    def test_alias_hit(self) -> None:
        assert _resolve_team_name("pies") == "Collingwood"

    def test_case_insensitive(self) -> None:
        assert _resolve_team_name("CATS") == "Geelong"

    def test_strips_whitespace(self) -> None:
        assert _resolve_team_name("  hawks  ") == "Hawthorn"

    def test_passthrough_unknown(self) -> None:
        assert _resolve_team_name("Collingwood") == "Collingwood"

    def test_all_aliases_map_to_known_teams(self) -> None:
        teams = set(TEAM_ALIAS_MAP.values())
        assert len(teams) == 18


# ---------------------------------------------------------------------------
# search_players
# ---------------------------------------------------------------------------


class TestSearchPlayers:
    """Verify player search query building."""

    def test_single_token_matches_first_or_surname(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_players("Martin")
            sql, params = mock.call_args[0]
            assert "ILIKE" in sql
            assert params == ["%Martin%", "%Martin%", 10]

    def test_two_tokens_match_first_and_surname(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_players("Dustin Martin")
            sql, params = mock.call_args[0]
            assert "first_name ILIKE" in sql
            assert "AND" in sql
            assert params == ["%Dustin%", "%Martin%", 10]

    def test_custom_limit(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_players("Foo", limit=5)
            _, params = mock.call_args[0]
            assert params[-1] == 5

    def test_empty_query_returns_empty(self) -> None:
        result = search_players("   ")
        assert result == []

    def test_multi_word_surname(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_players("Tom De Koning")
            _, params = mock.call_args[0]
            assert params[0] == "%Tom%"
            assert params[1] == "%De Koning%"


# ---------------------------------------------------------------------------
# get_ladder
# ---------------------------------------------------------------------------


class TestGetLadder:
    """Verify ladder query building."""

    def test_full_season_query(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            get_ladder(2024)
            sql, params = mock.call_args[0]
            assert "round_type = 'Regular'" in sql
            assert "round_number" not in sql
            assert params == [2024, 2024]

    def test_round_filter(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            get_ladder(2024, round_number=10)
            sql, params = mock.call_args[0]
            assert "round_number <= %s" in sql
            assert params == [2024, 10, 2024, 10]

    def test_premiership_points_in_select(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            get_ladder(2024)
            sql = mock.call_args[0][0]
            assert "premiership_points" in sql
            assert "wins" in sql and "draws" in sql

    def test_includes_position_column(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            get_ladder(2024)
            sql = mock.call_args[0][0]
            assert "ROW_NUMBER()" in sql
            assert "position" in sql


# ---------------------------------------------------------------------------
# stat_leaders
# ---------------------------------------------------------------------------


class TestStatLeaders:
    """Verify stat leaders query building."""

    def test_valid_stat(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            stat_leaders("goals")
            sql, params = mock.call_args[0]
            assert "SUM(pms.goals)" in sql
            assert params == [10]

    def test_invalid_stat_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid stat column"):
            stat_leaders("not_a_column")

    def test_season_filter(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            stat_leaders("disposals", season=2023)
            _, params = mock.call_args[0]
            assert params == [2023, 10]

    def test_custom_limit(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            stat_leaders("tackles", limit=25)
            _, params = mock.call_args[0]
            assert params == [25]

    def test_percentage_columns_excluded(self) -> None:
        for col in ("disposal_efficiency_pct", "hitout_win_pct", "time_on_ground_pct"):
            assert col not in VALID_STAT_COLUMNS


# ---------------------------------------------------------------------------
# head_to_head
# ---------------------------------------------------------------------------


class TestHeadToHead:
    """Verify head-to-head record computation."""

    def test_resolves_aliases(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]):
            result = head_to_head("pies", "blues")
            assert result["team1"] == "Collingwood"
            assert result["team2"] == "Carlton"

    def test_counts_wins(self) -> None:
        rows = [
            {
                "home_team": "Carlton",
                "away_team": "Collingwood",
                "margin": 20,
                "date": "2024-01-01",
                "round": "R1",
                "year": 2024,
                "venue": "MCG",
                "home_points": 100,
                "away_points": 80,
            },
            {
                "home_team": "Collingwood",
                "away_team": "Carlton",
                "margin": 10,
                "date": "2024-06-01",
                "round": "R10",
                "year": 2024,
                "venue": "MCG",
                "home_points": 90,
                "away_points": 80,
            },
            {
                "home_team": "Carlton",
                "away_team": "Collingwood",
                "margin": 0,
                "date": "2024-09-01",
                "round": "R20",
                "year": 2024,
                "venue": "MCG",
                "home_points": 80,
                "away_points": 80,
            },
        ]
        with patch(MOCK_EXECUTE, return_value=rows):
            result = head_to_head("Carlton", "Collingwood")
            assert result["team1_wins"] == 1
            assert result["team2_wins"] == 1
            assert result["draws"] == 1
            assert result["total_matches"] == 3

    def test_year_filters(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            head_to_head("Carlton", "Richmond", year_from=2015, year_to=2020)
            _, params = mock.call_args[0]
            assert 2015 in params
            assert 2020 in params


# ---------------------------------------------------------------------------
# player_career_summary
# ---------------------------------------------------------------------------


class TestPlayerCareerSummary:
    """Verify career summary retrieval."""

    def test_requires_id_or_name(self) -> None:
        with pytest.raises(ValueError, match="Provide either"):
            player_career_summary()

    def test_by_id(self) -> None:
        bio = [
            {
                "id": 1,
                "first_name": "Dustin",
                "surname": "Martin",
                "height_cm": 185,
                "weight_kg": 89,
            }
        ]
        totals = [
            {
                "games": 300,
                "goals": 330,
                "disposals": 5000,
                "kicks": 3000,
                "handballs": 2000,
                "marks": 1500,
                "tackles": 1200,
                "brownlow_votes": 40,
                "avg_disposals": 16.7,
                "avg_goals": 1.1,
                "debut": "2010-04-01",
                "last_game": "2024-09-01",
            }
        ]
        seasons = [
            {
                "year": 2024,
                "team": "Richmond",
                "games": 20,
                "goals": 15,
                "disposals": 300,
                "avg_disposals": 15.0,
            }
        ]
        with patch(MOCK_EXECUTE, side_effect=[bio, totals, seasons]):
            result = player_career_summary(player_id=1)
            assert result["player"]["first_name"] == "Dustin"
            assert result["career"]["games"] == 300
            assert len(result["seasons"]) == 1

    def test_by_name_delegates_to_search(self) -> None:
        search_result = [
            {
                "id": 42,
                "first_name": "Dustin",
                "surname": "Martin",
                "current_team": "Richmond",
            }
        ]
        bio = [
            {
                "id": 42,
                "first_name": "Dustin",
                "surname": "Martin",
                "height_cm": 185,
                "weight_kg": 89,
            }
        ]
        totals = [{"games": 300}]
        seasons = []
        with patch(MOCK_EXECUTE, side_effect=[search_result, bio, totals, seasons]):
            result = player_career_summary(player_name="Dustin Martin")
            assert result["player"]["id"] == 42

    def test_player_not_found(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]):
            with pytest.raises(ValueError, match="No player found"):
                player_career_summary(player_name="Nobody")


# ---------------------------------------------------------------------------
# player_comparison
# ---------------------------------------------------------------------------


class TestPlayerComparison:
    """Verify player comparison query building."""

    def test_multiple_players(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            player_comparison([1, 2, 3])
            sql, params = mock.call_args[0]
            assert "ANY(%s)" in sql
            assert params[0] == [1, 2, 3]

    def test_resolves_names(self) -> None:
        search_result = [
            {
                "id": 42,
                "first_name": "Dustin",
                "surname": "Martin",
                "current_team": "Richmond",
            }
        ]
        with patch(MOCK_EXECUTE, side_effect=[search_result, []]) as mock:
            player_comparison(["Dustin Martin"])
            comparison_sql, comparison_params = mock.call_args_list[1][0]
            assert comparison_params[0] == [42]

    def test_mixed_ids_and_names(self) -> None:
        search_result = [
            {
                "id": 42,
                "first_name": "Dustin",
                "surname": "Martin",
                "current_team": "Richmond",
            }
        ]
        with patch(MOCK_EXECUTE, side_effect=[search_result, []]) as mock:
            player_comparison([1, "Dustin Martin"])
            comparison_sql, comparison_params = mock.call_args_list[1][0]
            assert comparison_params[0] == [1, 42]

    def test_year_filters(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            player_comparison([1], year_from=2018, year_to=2022)
            _, params = mock.call_args[0]
            assert 2018 in params
            assert 2022 in params


# ---------------------------------------------------------------------------
# search_matches
# ---------------------------------------------------------------------------


class TestSearchMatches:
    """Verify match search query building."""

    def test_team_filter_resolves_alias(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_matches(team="tigers")
            _, params = mock.call_args[0]
            assert "Richmond" in params

    def test_venue_filter(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_matches(venue="MCG")
            sql, params = mock.call_args[0]
            assert "ILIKE" in sql
            assert "%MCG%" in params

    def test_margin_filters(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_matches(min_margin=50, max_margin=100)
            sql, params = mock.call_args[0]
            assert "ABS(m.margin) >= %s" in sql
            assert "ABS(m.margin) <= %s" in sql
            assert 50 in params
            assert 100 in params

    def test_no_filters(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_matches()
            sql, params = mock.call_args[0]
            assert "WHERE" not in sql
            assert params == [20]

    def test_custom_limit(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            search_matches(limit=5)
            _, params = mock.call_args[0]
            assert params[-1] == 5


# ---------------------------------------------------------------------------
# MCP server delegation tests
# ---------------------------------------------------------------------------


class TestMcpToolDelegation:
    """Verify MCP tool wrappers delegate to core functions."""

    def test_search_players_delegates(self) -> None:
        from afl_mcp.mcp_server.server import search_players as mcp_search

        with patch("afl_mcp.core.tools.search_players", return_value=[]) as mock:
            mcp_search("Dustin", 5)
            mock.assert_called_once_with("Dustin", 5)

    def test_get_ladder_delegates(self) -> None:
        from afl_mcp.mcp_server.server import get_ladder as mcp_ladder

        with patch("afl_mcp.core.tools.get_ladder", return_value=[]) as mock:
            mcp_ladder(2024, 10)
            mock.assert_called_once_with(2024, 10)

    def test_stat_leaders_delegates(self) -> None:
        from afl_mcp.mcp_server.server import stat_leaders as mcp_leaders

        with patch("afl_mcp.core.tools.stat_leaders", return_value=[]) as mock:
            mcp_leaders("goals", 2024, 10)
            mock.assert_called_once_with("goals", 2024, 10)

    def test_head_to_head_delegates(self) -> None:
        from afl_mcp.mcp_server.server import head_to_head as mcp_h2h

        with patch("afl_mcp.core.tools.head_to_head", return_value={}) as mock:
            mcp_h2h("Carlton", "Collingwood", 2020, 2024)
            mock.assert_called_once_with("Carlton", "Collingwood", 2020, 2024)

    def test_player_career_summary_delegates(self) -> None:
        from afl_mcp.mcp_server.server import player_career_summary as mcp_career

        with patch("afl_mcp.core.tools.player_career_summary", return_value={}) as mock:
            mcp_career(player_id=1)
            mock.assert_called_once_with(1, None)

    def test_player_comparison_delegates(self) -> None:
        from afl_mcp.mcp_server.server import player_comparison as mcp_compare

        with patch("afl_mcp.core.tools.player_comparison", return_value=[]) as mock:
            mcp_compare([1, 2])
            mock.assert_called_once_with([1, 2], None, None)

    def test_search_matches_delegates(self) -> None:
        from afl_mcp.mcp_server.server import search_matches as mcp_matches

        with patch("afl_mcp.core.tools.search_matches", return_value=[]) as mock:
            mcp_matches(team="Carlton", limit=5)
            mock.assert_called_once_with("Carlton", None, None, None, None, None, 5)

    def test_get_pav_leaders_delegates(self) -> None:
        from afl_mcp.mcp_server.server import get_pav_leaders as mcp_pav

        with patch("afl_mcp.core.tools.get_pav_leaders", return_value=[]) as mock:
            mcp_pav(2023, "off", 10)
            mock.assert_called_once_with(2023, "off", 10)

    def test_get_player_pav_delegates(self) -> None:
        from afl_mcp.mcp_server.server import get_player_pav as mcp_pav

        with patch("afl_mcp.core.tools.get_player_pav", return_value=[]) as mock:
            mcp_pav(player_id=1)
            mock.assert_called_once_with(1, None)


# ---------------------------------------------------------------------------
# get_pav_leaders
# ---------------------------------------------------------------------------


class TestGetPavLeaders:
    """Verify PAV leaders query building."""

    def test_default_sorts_by_total(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            get_pav_leaders(2023)
            sql, params = mock.call_args[0]
            assert "total_pav DESC" in sql
            assert params == [2023, 20]

    def test_zone_filter(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            get_pav_leaders(2023, zone="def")
            sql = mock.call_args[0][0]
            assert "def_pav DESC" in sql

    def test_invalid_zone_raises(self) -> None:
        with pytest.raises(ValueError, match="Invalid zone"):
            get_pav_leaders(2023, zone="attack")

    def test_custom_limit(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            get_pav_leaders(2023, limit=5)
            _, params = mock.call_args[0]
            assert params == [2023, 5]


# ---------------------------------------------------------------------------
# get_player_pav
# ---------------------------------------------------------------------------


class TestGetPlayerPav:
    """Verify player PAV history query."""

    def test_by_id(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]) as mock:
            get_player_pav(player_id=42)
            sql, params = mock.call_args[0]
            assert "player_season_pav" in sql
            assert params == [42]

    def test_by_name_delegates_to_search(self) -> None:
        search_result = [
            {
                "id": 42,
                "first_name": "Dustin",
                "surname": "Martin",
                "current_team": "Richmond",
            }
        ]
        with patch(MOCK_EXECUTE, side_effect=[search_result, []]):
            get_player_pav(player_name="Dustin Martin")

    def test_requires_id_or_name(self) -> None:
        with pytest.raises(ValueError, match="Provide either"):
            get_player_pav()

    def test_player_not_found(self) -> None:
        with patch(MOCK_EXECUTE, return_value=[]):
            with pytest.raises(ValueError, match="No player found"):
                get_player_pav(player_name="Nobody")
