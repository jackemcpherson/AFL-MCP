"""Tests for hybrid semantic search tools.

Verifies SQL construction, RRF fusion, filter building, enrichment,
and input validation. All tests mock the database and embedding model.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from afl_mcp.core.semantic_search import (
    _build_match_filters,
    _build_player_season_filters,
    _expand_query,
    _extract_query_filters,
    search_afl,
    search_match_summaries,
    search_player_seasons,
)

MOCK_POOL = "afl_mcp.core.semantic_search.get_pool"
MOCK_EMBED = "afl_mcp.core.semantic_search._get_query_vector"
FAKE_VECTOR = [0.1] * 384


class TestBuildMatchFilters:
    """Verify match filter SQL construction."""

    def test_no_filters(self) -> None:
        conditions, params = _build_match_filters()
        assert conditions == []
        assert params == []

    def test_year_range(self) -> None:
        conditions, params = _build_match_filters(year_from=2020, year_to=2024)
        assert len(conditions) == 2
        assert "s.year >= %s" in conditions[0]
        assert params == [2020, 2024]

    def test_team_resolves_alias(self) -> None:
        conditions, params = _build_match_filters(team="pies")
        assert any("ht.name" in c for c in conditions)
        assert "Collingwood" in params

    def test_round_type(self) -> None:
        conditions, params = _build_match_filters(round_type="Finals")
        assert "m.round_type = %s" in conditions[0]
        assert params == ["Finals"]

    def test_venue_partial(self) -> None:
        conditions, params = _build_match_filters(venue="MCG")
        assert "ILIKE" in conditions[0]
        assert "%MCG%" in params

    def test_exclude_match(self) -> None:
        conditions, params = _build_match_filters(exclude_match_id=123)
        assert "ms.match_id != %s" in conditions[0]
        assert params == [123]


class TestBuildPlayerSeasonFilters:
    """Verify player season filter SQL construction."""

    def test_no_filters(self) -> None:
        conditions, params = _build_player_season_filters()
        assert conditions == []
        assert params == []

    def test_min_games(self) -> None:
        conditions, params = _build_player_season_filters(min_games=15)
        assert len(conditions) == 1
        assert "COUNT" in conditions[0]
        assert params == [15]

    def test_team_resolves_alias(self) -> None:
        conditions, params = _build_player_season_filters(team="cats")
        assert "EXISTS" in conditions[0]
        assert "Geelong" in params

    def test_exclude_player(self) -> None:
        conditions, params = _build_player_season_filters(
            exclude_player_id=1,
        )
        assert "player_id != %s" in conditions[0]
        assert params == [1]


class TestSearchMatchSummaries:
    """Verify match summary search behavior."""

    def test_requires_query_or_match_id(self) -> None:
        with pytest.raises(ValueError, match="exactly one"):
            search_match_summaries()

    def test_rejects_both_query_and_match_id(self) -> None:
        with pytest.raises(ValueError, match="exactly one"):
            search_match_summaries(query="test", match_id=1)

    @patch(MOCK_POOL)
    @patch(MOCK_EMBED, return_value=FAKE_VECTOR)
    def test_query_mode_calls_embed(
        self, mock_embed: MagicMock, mock_pool: MagicMock
    ) -> None:
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = []
        mock_pool.return_value.connection.return_value.__enter__ = MagicMock(
            return_value=mock_conn
        )
        mock_pool.return_value.connection.return_value.__exit__ = MagicMock(
            return_value=False
        )

        search_match_summaries(query="grand final")
        mock_embed.assert_called_once_with("grand final")

    @patch(MOCK_POOL)
    def test_match_id_mode_uses_stored_embedding(self, mock_pool: MagicMock) -> None:
        mock_cursor = MagicMock()
        mock_cursor.execute.return_value.fetchone.return_value = {
            "embedding": FAKE_VECTOR
        }
        mock_cursor.execute.return_value.fetchall.return_value = []

        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        mock_pool.return_value.connection.return_value.__enter__ = MagicMock(
            return_value=mock_conn
        )
        mock_pool.return_value.connection.return_value.__exit__ = MagicMock(
            return_value=False
        )

        search_match_summaries(match_id=123)
        first_sql = mock_cursor.execute.call_args_list[0][0][0]
        assert "embedding" in first_sql
        assert "match_summaries" in first_sql


class TestSearchPlayerSeasons:
    """Verify player season search behavior."""

    def test_requires_query_or_player_year(self) -> None:
        with pytest.raises(ValueError, match="exactly one"):
            search_player_seasons()

    def test_rejects_player_without_year(self) -> None:
        with pytest.raises(ValueError, match="Both"):
            search_player_seasons(player_id=1)

    def test_rejects_year_without_player(self) -> None:
        with pytest.raises(ValueError, match="Both"):
            search_player_seasons(year=2024)

    def test_rejects_query_and_player_id(self) -> None:
        with pytest.raises(ValueError, match="exactly one"):
            search_player_seasons(query="test", player_id=1, year=2024)

    @patch(MOCK_POOL)
    @patch(MOCK_EMBED, return_value=FAKE_VECTOR)
    def test_query_mode(self, mock_embed: MagicMock, mock_pool: MagicMock) -> None:
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = []
        mock_pool.return_value.connection.return_value.__enter__ = MagicMock(
            return_value=mock_conn
        )
        mock_pool.return_value.connection.return_value.__exit__ = MagicMock(
            return_value=False
        )

        search_player_seasons(query="30 disposals per game")
        mock_embed.assert_called_once_with("30 disposals per game")


class TestSearchAfl:
    """Verify unified search behavior."""

    @patch(MOCK_POOL)
    @patch(MOCK_EMBED, return_value=FAKE_VECTOR)
    def test_embeds_query_once(
        self, mock_embed: MagicMock, mock_pool: MagicMock
    ) -> None:
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = []
        mock_pool.return_value.connection.return_value.__enter__ = MagicMock(
            return_value=mock_conn
        )
        mock_pool.return_value.connection.return_value.__exit__ = MagicMock(
            return_value=False
        )

        search_afl(query="Geelong 2007")
        mock_embed.assert_called_once_with("Geelong 2007")

    @patch(
        "afl_mcp.core.semantic_search._enrich_player_seasons",
        return_value={
            200: {
                "player_id": 10,
                "first_name": "Gary",
                "surname": "Ablett",
                "team": "Geelong",
                "year": 2007,
                "games": 25,
                "pav": None,
            }
        },
    )
    @patch(
        "afl_mcp.core.semantic_search._enrich_matches",
        return_value={
            100: {
                "match_id": 100,
                "home_team": "Geelong",
                "away_team": "Port Adelaide",
                "year": 2007,
                "top_performers": [],
            }
        },
    )
    @patch(
        "afl_mcp.core.semantic_search._hybrid_search",
        side_effect=[
            [{"entity_id": 100, "score": 0.03}],
            [{"entity_id": 200, "score": 0.025}],
        ],
    )
    @patch(MOCK_EMBED, return_value=FAKE_VECTOR)
    def test_returns_typed_results(
        self,
        _mock_embed: MagicMock,
        _mock_hybrid: MagicMock,
        _mock_enrich_m: MagicMock,
        _mock_enrich_p: MagicMock,
    ) -> None:
        results = search_afl(query="Geelong 2007")

        assert len(results) == 2
        assert results[0]["rank"] == 1
        assert results[0]["type"] == "match"
        assert results[0]["home_team"] == "Geelong"
        assert results[1]["rank"] == 2
        assert results[1]["type"] == "player_season"
        assert results[1]["surname"] == "Ablett"


class TestExpandQuery:
    """Verify synonym expansion at query time."""

    def test_no_synonyms_returns_original(self) -> None:
        assert _expand_query("Geelong 2007") == "Geelong 2007"

    def test_grand_final_expansion(self) -> None:
        result = _expand_query("grand final at the MCG")
        assert "GF" in result
        assert result.startswith("grand final at the MCG")

    def test_multiple_synonyms(self) -> None:
        result = _expand_query("close grand final")
        assert "GF" in result
        assert "Margin:" in result

    def test_ruckman_expansion(self) -> None:
        result = _expand_query("dominant ruckman season")
        assert "hitouts" in result

    def test_midfielder_expansion(self) -> None:
        result = _expand_query("elite midfielder")
        assert "disposals" in result
        assert "clearances" in result
        assert "tackles" in result

    def test_draw_expansion(self) -> None:
        result = _expand_query("draw at the MCG")
        assert "drew with" in result
        assert "Margin: 0" in result

    def test_case_insensitive(self) -> None:
        result = _expand_query("Grand Final")
        assert "GF" in result

    def test_original_always_preserved(self) -> None:
        original = "blowout win"
        result = _expand_query(original)
        assert result.startswith(original)


class TestExtractQueryFilters:
    """Verify query filter extraction (numeric + semantic)."""

    def test_no_filters_for_plain_query(self) -> None:
        conds, params = _extract_query_filters("Geelong 2007", "match")
        assert conds == []
        assert params == []

    # --- Match: explicit numeric margin ---

    def test_margin_close_game(self) -> None:
        conds, params = _extract_query_filters("close game margin under 10", "match")
        assert any("ABS(m.margin) <=" in c for c in conds)
        assert 10 in params

    def test_margin_blowout(self) -> None:
        conds, params = _extract_query_filters("blowout margin over 80", "match")
        assert any("ABS(m.margin) >=" in c for c in conds)
        assert 80 in params

    def test_margin_default_lte(self) -> None:
        conds, params = _extract_query_filters("margin 20", "match")
        assert any("ABS(m.margin) <=" in c for c in conds)
        assert 20 in params

    # --- Match: semantic round filters ---

    def test_grand_final_round_filter(self) -> None:
        conds, params = _extract_query_filters("grand final at the MCG", "match")
        assert "m.round = %s" in conds
        assert "GF" in params

    def test_preliminary_final_round_filter(self) -> None:
        conds, params = _extract_query_filters("preliminary final", "match")
        assert "m.round = %s" in conds
        assert "PF" in params

    def test_finals_round_type_filter(self) -> None:
        conds, params = _extract_query_filters("best finals performances", "match")
        assert "m.round_type = %s" in conds
        assert "Finals" in params

    def test_specific_final_does_not_add_generic_finals(self) -> None:
        conds, params = _extract_query_filters("grand final thriller", "match")
        assert "m.round_type = %s" not in conds
        assert "m.round = %s" in conds

    # --- Match: semantic margin filters ---

    def test_close_game_semantic_margin(self) -> None:
        conds, params = _extract_query_filters("close game at the MCG", "match")
        assert any("ABS(m.margin) <=" in c for c in conds)
        assert 10 in params

    def test_nail_biter_semantic_margin(self) -> None:
        conds, params = _extract_query_filters("nail-biter at Kardinia Park", "match")
        assert any("ABS(m.margin) <=" in c for c in conds)

    def test_blowout_semantic_margin(self) -> None:
        conds, params = _extract_query_filters("biggest blowout", "match")
        assert any("ABS(m.margin) >=" in c for c in conds)
        assert 60 in params

    def test_draw_filter(self) -> None:
        conds, params = _extract_query_filters("draw at the MCG", "match")
        assert "m.margin = 0" in conds

    def test_explicit_margin_overrides_semantic(self) -> None:
        conds, params = _extract_query_filters("close game margin under 5", "match")
        # Should use explicit 5, not semantic 10
        assert 5 in params
        assert 10 not in params

    # --- Player season: numeric ---

    def test_disposals_filter(self) -> None:
        conds, params = _extract_query_filters("30 disposals per game", "player_season")
        assert len(conds) == 1
        assert "AVG" in conds[0]
        assert "disposals" in conds[0]
        assert params == [28]  # 30 - 2

    def test_goals_filter(self) -> None:
        conds, params = _extract_query_filters("50 goals in a season", "player_season")
        assert len(conds) == 1
        assert "SUM" in conds[0]
        assert "goals" in conds[0]
        assert params == [45]  # 50 - 5

    def test_both_disposals_and_goals(self) -> None:
        conds, params = _extract_query_filters(
            "30 disposals and 20 goals", "player_season"
        )
        assert len(conds) == 2
        assert params == [28, 15]

    # --- Player season: positional ---

    def test_ruckman_hitouts_filter(self) -> None:
        conds, params = _extract_query_filters(
            "dominant ruckman season", "player_season"
        )
        assert any("hitouts" in c for c in conds)
        assert 15 in params

    def test_ruck_hitouts_filter(self) -> None:
        conds, params = _extract_query_filters("best ruck seasons", "player_season")
        assert any("hitouts" in c for c in conds)

    def test_key_forward_goals_filter(self) -> None:
        conds, params = _extract_query_filters("key forward season", "player_season")
        assert any("goals" in c for c in conds)
        assert 1.5 in params

    def test_forward_goals_filter(self) -> None:
        conds, params = _extract_query_filters("best forward season", "player_season")
        assert any("goals" in c for c in conds)
        assert 1.0 in params

    def test_midfielder_disposals_filter(self) -> None:
        conds, params = _extract_query_filters(
            "elite midfielder season", "player_season"
        )
        assert any("disposals" in c for c in conds)
        assert 20 in params

    def test_defender_intercepts_filter(self) -> None:
        conds, params = _extract_query_filters("best defender season", "player_season")
        assert any("intercepts" in c for c in conds)
        assert 4 in params

    def test_ruckman_with_explicit_disposals_skips_hitouts(self) -> None:
        conds, params = _extract_query_filters(
            "ruckman with 20 disposals", "player_season"
        )
        # Should have disposals filter from explicit number, not hitouts
        assert any("disposals" in c for c in conds)
        assert 18 in params  # 20 - 2
        # Hitouts should still be added (ruck keyword present, disp_match doesn't block it)
        # Actually, disp_match blocks ruck hitouts filter — let's verify
        assert not any("hitouts" in c for c in conds)

    # --- Cross-type checks ---

    def test_wrong_search_type_ignored(self) -> None:
        conds, params = _extract_query_filters("30 disposals per game", "match")
        assert conds == []

    def test_match_margin_ignored_for_player_season(self) -> None:
        conds, params = _extract_query_filters("margin 10", "player_season")
        assert conds == []


class TestMcpDelegation:
    """Verify MCP tool wrappers delegate correctly."""

    def test_search_match_summaries_delegates(self) -> None:
        from afl_mcp.mcp_server.server import search_match_summaries as mcp_fn

        with patch(
            "afl_mcp.core.semantic_search.search_match_summaries", return_value=[]
        ) as mock:
            mcp_fn(query="test", limit=5)
            mock.assert_called_once_with("test", None, 5, None, None, None, None, None)

    def test_search_player_seasons_delegates(self) -> None:
        from afl_mcp.mcp_server.server import search_player_seasons as mcp_fn

        with patch(
            "afl_mcp.core.semantic_search.search_player_seasons", return_value=[]
        ) as mock:
            mcp_fn(query="test", limit=5)
            mock.assert_called_once_with("test", None, None, 5, None, None, None, None)

    def test_search_afl_delegates(self) -> None:
        from afl_mcp.mcp_server.server import search_afl as mcp_fn

        with patch("afl_mcp.core.semantic_search.search_afl", return_value=[]) as mock:
            mcp_fn(query="test", limit=5)
            mock.assert_called_once_with("test", 5, None, None, None)
