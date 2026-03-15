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

    def test_exclude_player_season(self) -> None:
        conditions, params = _build_player_season_filters(
            exclude_player_id=1, exclude_season_id=10
        )
        assert "NOT" in conditions[0]
        assert params == [1, 10]


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
        assert results[0]["type"] == "match"
        assert results[0]["home_team"] == "Geelong"
        assert results[1]["type"] == "player_season"
        assert results[1]["surname"] == "Ablett"


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
