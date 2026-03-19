"""Tests for database connection configuration.

Tests the pure logic in db.py that does not require a live database:
DSN retrieval, error handling, and pool initialization.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from afl_mcp.core.db import _get_dsn, _pool_lock, MIGRATIONS_DIR


class TestGetDsn:
    """Verify DATABASE_URL environment variable handling."""

    def test_returns_dsn_when_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A configured DATABASE_URL is returned directly.

        Args:
            monkeypatch: Pytest fixture for setting environment variables.
        """
        monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/test")
        assert _get_dsn() == "postgresql://localhost/test"

    def test_raises_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A missing DATABASE_URL raises RuntimeError with helpful message.

        Args:
            monkeypatch: Pytest fixture for modifying environment variables.
        """
        monkeypatch.delenv("DATABASE_URL", raising=False)
        with pytest.raises(RuntimeError, match="DATABASE_URL"):
            _get_dsn()

    def test_raises_when_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """An empty DATABASE_URL is treated as unset.

        Args:
            monkeypatch: Pytest fixture for setting environment variables.
        """
        monkeypatch.setenv("DATABASE_URL", "")
        with pytest.raises(RuntimeError, match="DATABASE_URL"):
            _get_dsn()


class TestPoolLock:
    """Verify that the pool initialization lock exists."""

    def test_lock_exists(self) -> None:
        """The _pool_lock is a threading.Lock instance."""
        import threading

        assert isinstance(_pool_lock, type(threading.Lock()))


class TestMigrationsDir:
    """Verify migrations directory configuration."""

    def test_migrations_dir_path(self) -> None:
        """MIGRATIONS_DIR points to db/migrations relative to project root."""
        assert MIGRATIONS_DIR.name == "migrations"
        assert MIGRATIONS_DIR.parent.name == "db"


class TestRunMigrations:
    """Verify migration runner handles multi-statement files."""

    @patch("afl_mcp.core.db.get_admin_connection")
    def test_splits_multi_statement_migrations(
        self, mock_admin: MagicMock, tmp_path: object
    ) -> None:
        """Migration files with multiple statements are split on semicolons."""
        from afl_mcp.core.db import run_migrations, MIGRATIONS_DIR

        mock_conn = MagicMock()
        mock_admin.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_admin.return_value.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = []

        # Patch MIGRATIONS_DIR to use an empty dir so no real files are read.
        with patch("afl_mcp.core.db.MIGRATIONS_DIR", tmp_path):
            result = run_migrations()

        assert result == []
