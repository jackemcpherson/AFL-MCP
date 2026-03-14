"""Tests for database connection configuration.

Tests the pure logic in db.py that does not require a live database:
DSN retrieval and error handling.
"""

from __future__ import annotations


import pytest

from afl_mcp.core.db import _get_dsn


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
