"""Tests for CLI helper functions.

Tests the pure utility functions used by the CLI that do not
require a database connection or Rich console.
"""

from __future__ import annotations


from afl_mcp.cli.main import _is_numeric


class TestIsNumeric:
    """Verify numeric detection for table column alignment."""

    def test_integer_is_numeric(self) -> None:
        """Python int values are detected as numeric."""
        assert _is_numeric(42) is True

    def test_float_is_numeric(self) -> None:
        """Python float values are detected as numeric."""
        assert _is_numeric(3.14) is True

    def test_zero_is_numeric(self) -> None:
        """Zero is numeric, not falsy."""
        assert _is_numeric(0) is True

    def test_negative_is_numeric(self) -> None:
        """Negative numbers are detected as numeric."""
        assert _is_numeric(-7) is True

    def test_numeric_string_is_numeric(self) -> None:
        """String representations of numbers are detected."""
        assert _is_numeric("42") is True
        assert _is_numeric("3.14") is True
        assert _is_numeric("-7") is True

    def test_non_numeric_string_is_not_numeric(self) -> None:
        """Regular text strings are not numeric."""
        assert _is_numeric("Carlton") is False
        assert _is_numeric("") is False

    def test_none_is_not_numeric(self) -> None:
        """None values are not numeric (column should default to left-align)."""
        assert _is_numeric(None) is False

    def test_bool_is_detected_as_numeric(self) -> None:
        """Booleans are int subclasses and pass the isinstance(int) check.

        This is intentional — bool columns in SQL results will be
        right-aligned, which is acceptable behavior.
        """
        assert _is_numeric(True) is True
        assert _is_numeric(False) is True

    def test_non_standard_types_are_not_numeric(self) -> None:
        """Objects like lists and dicts are not numeric."""
        assert _is_numeric([1, 2]) is False
        assert _is_numeric({"a": 1}) is False
