"""Integration tests that verify end-to-end query execution.

These tests require a running PostgreSQL instance with the AFL-MCP
schema applied and data loaded. They are skipped if DATABASE_URL
is not set or the database is unreachable.
"""

from __future__ import annotations

import os

import pytest

requires_db = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; skipping integration tests",
)


@requires_db
class TestQueryExecution:
    """Verify end-to-end query execution against the live database."""

    def test_select_count_returns_result(self) -> None:
        """A simple COUNT query returns a single-row result."""
        from afl_mcp.core.queries import execute_query

        result = execute_query("SELECT count(*) AS total FROM matches")
        assert len(result) == 1
        assert "total" in result[0]
        assert isinstance(result[0]["total"], int)
        assert result[0]["total"] > 0

    def test_write_statement_raises_value_error(self) -> None:
        """Attempting a DELETE raises ValueError before hitting the database."""
        from afl_mcp.core.queries import execute_query

        with pytest.raises(ValueError, match="forbidden"):
            execute_query("DELETE FROM matches")

    def test_parameterised_query(self) -> None:
        """Parameterised queries execute correctly and return typed results."""
        from afl_mcp.core.queries import execute_query

        result = execute_query(
            "SELECT name FROM teams WHERE name = %s",
            ("Carlton",),
        )
        assert len(result) == 1
        assert result[0]["name"] == "Carlton"

    def test_empty_result_returns_empty_list(self) -> None:
        """A query matching no rows returns an empty list, not None."""
        from afl_mcp.core.queries import execute_query

        result = execute_query(
            "SELECT * FROM teams WHERE name = %s",
            ("NonexistentTeam",),
        )
        assert result == []


@requires_db
class TestSchemaIntrospection:
    """Verify schema introspection queries against the live database."""

    def test_get_schema_info_all_tables(self) -> None:
        """Requesting all tables returns rows for known tables."""
        from afl_mcp.core.queries import get_schema_info

        result = get_schema_info()
        table_names = {row["table_name"] for row in result}
        assert "matches" in table_names
        assert "players" in table_names
        assert "player_match_stats" in table_names

    def test_get_schema_info_single_table(self) -> None:
        """Requesting a specific table returns only its columns."""
        from afl_mcp.core.queries import get_schema_info

        result = get_schema_info("players")
        assert all(row["table_name"] == "players" for row in result)
        column_names = {row["column_name"] for row in result}
        assert "surname" in column_names
        assert "external_id" in column_names

    def test_get_foreign_keys(self) -> None:
        """Foreign key query returns known relationships."""
        from afl_mcp.core.queries import get_foreign_keys

        result = get_foreign_keys()
        fk_pairs = {(row["table_name"], row["foreign_table_name"]) for row in result}
        assert ("matches", "seasons") in fk_pairs
        assert ("player_match_stats", "players") in fk_pairs


@requires_db
class TestDataIntegrity:
    """Verify that the loaded data has the expected shape and relationships."""

    def test_all_teams_have_matches(self) -> None:
        """Every team in the teams table appears in at least one match."""
        from afl_mcp.core.queries import execute_query

        orphan_teams = execute_query("""
            SELECT t.name FROM teams t
            WHERE NOT EXISTS (
                SELECT 1 FROM matches m
                WHERE m.home_team_id = t.id OR m.away_team_id = t.id
            )
        """)
        assert orphan_teams == [], (
            f"Teams with no matches: {[t['name'] for t in orphan_teams]}"
        )

    def test_player_match_stats_reference_valid_matches(self) -> None:
        """No player_match_stats rows point to nonexistent matches."""
        from afl_mcp.core.queries import execute_query

        orphans = execute_query("""
            SELECT count(*) AS cnt FROM player_match_stats pms
            WHERE NOT EXISTS (
                SELECT 1 FROM matches m WHERE m.id = pms.match_id
            )
        """)
        assert orphans[0]["cnt"] == 0

    def test_expected_row_counts(self) -> None:
        """Sanity check that tables have reasonable row counts."""
        from afl_mcp.core.queries import execute_query

        teams = execute_query("SELECT count(*) AS cnt FROM teams")
        assert teams[0]["cnt"] == 18

        seasons = execute_query("SELECT count(*) AS cnt FROM seasons")
        assert seasons[0]["cnt"] >= 10

        matches = execute_query("SELECT count(*) AS cnt FROM matches")
        assert matches[0]["cnt"] > 2000

        stats = execute_query("SELECT count(*) AS cnt FROM player_match_stats")
        assert stats[0]["cnt"] > 90000
