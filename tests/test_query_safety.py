"""Tests for the read-only SQL query safety guard.

Validates that the regex-based forbidden statement filter correctly
blocks write operations while allowing legitimate SELECT queries,
including edge cases like column names containing SQL keywords.
"""

from __future__ import annotations

import re

import pytest

from afl_mcp.core.queries import _FORBIDDEN_PATTERN


class TestForbiddenPatternBlocksWrites:
    """Verify that known dangerous SQL statements are rejected."""

    @pytest.mark.parametrize("sql", [
        "INSERT INTO matches VALUES (1)",
        "insert into matches values (1)",
        "UPDATE matches SET margin = 0",
        "DELETE FROM players",
        "DROP TABLE matches",
        "ALTER TABLE matches ADD COLUMN foo INT",
        "TRUNCATE players",
        "CREATE TABLE evil (id int)",
        "GRANT ALL ON matches TO public",
        "REVOKE SELECT ON matches FROM readonly",
    ])
    def test_blocks_write_statements(self, sql: str) -> None:
        """Each SQL write keyword triggers the forbidden pattern.

        Args:
            sql: A SQL statement containing a write keyword.
        """
        assert _FORBIDDEN_PATTERN.search(sql) is not None

    @pytest.mark.parametrize("sql", [
        "SELECT * FROM matches",
        "SELECT count(*) FROM players WHERE surname = 'Smith'",
        "SELECT updated_at FROM matches",
        "SELECT insertion_date FROM logs",
        "SELECT created_at, deleted_flag FROM players",
        "SELECT truncated_name FROM teams",
        "SELECT alteration_count FROM schema_migrations",
        "SELECT * FROM matches WHERE round = 'GF'",
    ])
    def test_allows_select_queries(self, sql: str) -> None:
        """SELECT queries pass the filter, even with keyword substrings in column names.

        Args:
            sql: A legitimate SELECT query.
        """
        assert _FORBIDDEN_PATTERN.search(sql) is None

    def test_case_insensitive_blocking(self) -> None:
        """Mixed-case write keywords are still caught."""
        assert _FORBIDDEN_PATTERN.search("DeLeTe FROM matches") is not None
        assert _FORBIDDEN_PATTERN.search("Insert INTO foo") is not None

    def test_multiline_statement_blocked(self) -> None:
        """Write keywords embedded in multiline SQL are caught."""
        sql = """
            SELECT * FROM matches;
            DROP TABLE matches;
        """
        assert _FORBIDDEN_PATTERN.search(sql) is not None


class TestExecuteQueryRejectsWrites:
    """Verify that execute_query raises ValueError for forbidden SQL."""

    def test_delete_raises_value_error(self) -> None:
        """A DELETE statement raises ValueError before any DB call."""
        from afl_mcp.core.queries import execute_query

        with pytest.raises(ValueError, match="forbidden"):
            execute_query("DELETE FROM matches")

    def test_insert_raises_value_error(self) -> None:
        """An INSERT statement raises ValueError before any DB call."""
        from afl_mcp.core.queries import execute_query

        with pytest.raises(ValueError, match="forbidden"):
            execute_query("INSERT INTO matches VALUES (1)")

    def test_drop_raises_value_error(self) -> None:
        """A DROP statement raises ValueError before any DB call."""
        from afl_mcp.core.queries import execute_query

        with pytest.raises(ValueError, match="forbidden"):
            execute_query("DROP TABLE matches")


class TestForbiddenPatternEdgeCases:
    """Edge cases that the word-boundary regex must handle correctly."""

    def test_keyword_inside_string_literal_is_still_caught(self) -> None:
        """The regex does not parse SQL strings, so keywords in literals trigger it.

        This is a known false positive — the PostgreSQL read-only session
        is the real safety net. The regex is intentionally conservative.
        """
        sql = "SELECT * FROM matches WHERE note = 'DELETE ME'"
        assert _FORBIDDEN_PATTERN.search(sql) is not None

    def test_keyword_as_table_prefix_not_caught(self) -> None:
        """Words like 'INSERTS' or 'UPDATES' are not blocked (no word boundary)."""
        assert _FORBIDDEN_PATTERN.search("SELECT * FROM inserts_log") is None
        assert _FORBIDDEN_PATTERN.search("SELECT * FROM updates_history") is None

    def test_grant_surname_is_false_positive(self) -> None:
        """Surname 'Grant' triggers the GRANT keyword filter.

        This is a known false positive. The regex cannot distinguish SQL
        keywords from data values in string literals. The PostgreSQL
        read-only session setting is the real safety net.
        """
        sql = "SELECT * FROM players WHERE surname = 'Grant'"
        assert _FORBIDDEN_PATTERN.search(sql) is not None
