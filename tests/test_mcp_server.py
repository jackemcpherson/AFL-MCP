"""Tests for MCP server tool functions.

Verifies that MCP tools correctly delegate to core functions and
propagate errors (especially the ValueError for forbidden SQL).
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from afl_mcp.mcp_server.server import execute_sql, get_last_updated, get_schema


class TestExecuteSql:
    """Verify the execute_sql MCP tool."""

    def test_delegates_to_execute_query(self) -> None:
        """The tool passes SQL through to the core execute_query function."""
        expected = [{"count": 42}]
        with patch("afl_mcp.core.queries.execute_query", return_value=expected) as mock:
            result = execute_sql("SELECT count(*) FROM matches")
            mock.assert_called_once_with("SELECT count(*) FROM matches")
            assert result == expected

    def test_propagates_value_error_for_forbidden_sql(self) -> None:
        """Forbidden SQL raises ValueError to the MCP client, not swallowed."""
        with patch(
            "afl_mcp.core.queries.execute_query",
            side_effect=ValueError("forbidden"),
        ):
            with pytest.raises(ValueError, match="forbidden"):
                execute_sql("DROP TABLE matches")


class TestGetSchema:
    """Verify the get_schema MCP tool."""

    def test_returns_columns_and_foreign_keys(self) -> None:
        """When no table specified, returns both columns and foreign keys."""
        mock_columns = [{"table_name": "matches", "column_name": "id"}]
        mock_fks = [{"table_name": "matches", "foreign_table_name": "seasons"}]
        expected = {"columns": mock_columns, "foreign_keys": mock_fks}

        with patch("afl_mcp.core.queries.get_schema_dict", return_value=expected):
            result = get_schema()
            assert result["columns"] == mock_columns
            assert result["foreign_keys"] == mock_fks

    def test_single_table_omits_foreign_keys(self) -> None:
        """When a specific table is given, foreign keys are not included."""
        mock_columns = [{"table_name": "players", "column_name": "surname"}]
        expected = {"columns": mock_columns}

        with patch("afl_mcp.core.queries.get_schema_dict", return_value=expected):
            result = get_schema(table_name="players")
            assert result["columns"] == mock_columns
            assert "foreign_keys" not in result


class TestGetLastUpdated:
    """Verify the get_last_updated MCP tool."""

    def test_delegates_to_core(self) -> None:
        expected = {"total_matches": 6877, "total_players": 3681}
        with patch(
            "afl_mcp.core.queries.get_last_updated", return_value=expected
        ) as mock:
            result = get_last_updated()
            mock.assert_called_once()
            assert result == expected
