"""Tests for semantic search SQL query construction.

Tests that filtered_semantic_search builds correct SQL with the
right WHERE clauses and parameter ordering. Uses monkeypatching
to avoid needing a live database or embedding model.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch


class TestFilteredSemanticSearchQueryBuilding:
    """Verify that filters produce correct SQL WHERE clauses."""

    def _run_search(self, **kwargs: object) -> tuple[str, list]:
        """Execute a search with mocked pool and embeddings, capturing the SQL.

        Args:
            **kwargs: Arguments to pass to filtered_semantic_search.

        Returns:
            Tuple of (executed SQL string, parameter list).
        """
        captured_sql: list[str] = []
        captured_params: list[list] = []

        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = []

        def capture_execute(sql: str, params: object = None) -> MagicMock:
            """Capture SQL and params for inspection.

            Args:
                sql: The SQL query.
                params: The query parameters.

            Returns:
                A mock cursor.
            """
            captured_sql.append(sql)
            captured_params.append(list(params) if params else [])
            result = MagicMock()
            result.fetchall.return_value = []
            return result

        mock_conn.execute = capture_execute

        mock_pool = MagicMock()
        mock_pool.connection.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_pool.connection.return_value.__exit__ = MagicMock(return_value=False)

        fake_embedding = [0.1] * 384

        with (
            patch("afl_mcp.core.search.get_pool", return_value=mock_pool),
            patch("afl_mcp.core.search.embed_text", return_value=fake_embedding),
        ):
            from afl_mcp.core.search import filtered_semantic_search

            filtered_semantic_search(**kwargs)

        return captured_sql[-1], captured_params[-1]

    def test_no_filters_produces_no_top_level_where(self) -> None:
        """A search with no filters has no filter WHERE clause.

        The LATERAL subquery contains its own WHERE, so we check that
        no AND-joined filter conditions appear after the FROM block.
        """
        sql, _ = self._run_search(query="midfielders")
        after_lateral = sql.split("ON true")[-1] if "ON true" in sql else sql
        assert "WHERE" not in after_lateral

    def test_team_filter_added_for_player_season(self) -> None:
        """Team filter produces an ILIKE condition on team name."""
        sql, params = self._run_search(query="midfielders", team="Carlton")
        assert "ILIKE" in sql
        assert "%Carlton%" in params

    def test_team_filter_added_for_match(self) -> None:
        """Match team filter checks both home and away team names."""
        sql, params = self._run_search(
            query="close games", entity_type="match", team="Richmond"
        )
        assert sql.count("ILIKE") == 2
        assert "%Richmond%" in params

    def test_season_from_filter(self) -> None:
        """Season from filter adds a >= condition on year."""
        sql, params = self._run_search(query="test", season_from=2020)
        assert "s.year >= %s" in sql
        assert 2020 in params

    def test_season_to_filter(self) -> None:
        """Season to filter adds a <= condition on year."""
        sql, params = self._run_search(query="test", season_to=2023)
        assert "s.year <= %s" in sql
        assert 2023 in params

    def test_player_name_filter(self) -> None:
        """Player name filter adds an ILIKE on surname."""
        sql, params = self._run_search(query="test", player_name="Cripps")
        assert "p.surname ILIKE" in sql
        assert "%Cripps%" in params

    def test_venue_filter_for_match(self) -> None:
        """Venue filter works on match entity type."""
        sql, params = self._run_search(query="test", entity_type="match", venue="MCG")
        assert "v.name ILIKE" in sql
        assert "%MCG%" in params

    def test_multiple_filters_combined(self) -> None:
        """Multiple filters are joined with AND."""
        sql, _ = self._run_search(
            query="test", team="Carlton", season_from=2020, season_to=2023
        )
        assert "AND" in sql

    def test_limit_is_last_param(self) -> None:
        """The limit parameter is always the last in the params list."""
        _, params = self._run_search(query="test", limit=5)
        assert params[-1] == 5

    def test_match_entity_type_uses_match_summaries(self) -> None:
        """Match searches query the match_summaries table."""
        sql, _ = self._run_search(query="test", entity_type="match")
        assert "match_summaries" in sql


class TestSemanticSearchDelegation:
    """Verify that semantic_search delegates to filtered_semantic_search."""

    def test_delegates_correctly(self) -> None:
        """semantic_search calls filtered_semantic_search with no filters."""
        with patch("afl_mcp.core.search.filtered_semantic_search") as mock:
            mock.return_value = []
            from afl_mcp.core.search import semantic_search

            semantic_search(query="test", entity_type="match", limit=5)
            mock.assert_called_once_with(query="test", entity_type="match", limit=5)
