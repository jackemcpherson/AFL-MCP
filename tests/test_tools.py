"""Tests for high-level AFL statistics tools.

Verifies core tool functions build correct SQL and handle edge cases.
All tests mock execute_query to avoid needing a database.
"""

from __future__ import annotations

from unittest.mock import patch

from afl_mcp.core.tools import (
    TEAM_ALIAS_MAP,
    _resolve_team_name,
    get_ladder,
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
# MCP server delegation tests
# ---------------------------------------------------------------------------


class TestMcpToolDelegation:
    """Verify MCP tool wrappers delegate to core functions."""

    def test_get_ladder_delegates(self) -> None:
        from afl_mcp.mcp_server.server import get_ladder as mcp_ladder

        with patch("afl_mcp.core.tools.get_ladder", return_value=[]) as mock:
            mcp_ladder(2024, 10)
            mock.assert_called_once_with(2024, 10)

    def test_get_last_updated_delegates(self) -> None:
        from afl_mcp.mcp_server.server import get_last_updated as mcp_status

        with patch("afl_mcp.core.queries.get_last_updated", return_value={}) as mock:
            mcp_status()
            mock.assert_called_once()
