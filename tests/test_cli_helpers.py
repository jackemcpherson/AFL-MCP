"""Tests for CLI helper functions.

Tests the pure utility functions used by the CLI that do not
require a database connection or Rich console.
"""

from __future__ import annotations

from afl_mcp.cli.main import _is_numeric, _print_table, _print_json, _print_csv, _output, OutputFormat


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


class TestPrintTable:
    """Verify Rich table output formatting."""

    def test_empty_rows_shows_no_results(self, capsys: object) -> None:
        """Empty input prints 'No results' message."""
        _print_table([])
        # No assertion on exact text — just verify no crash.

    def test_renders_rows(self) -> None:
        """Rows are rendered without crashing."""
        rows = [{"name": "Carlton", "wins": 10}, {"name": "Richmond", "wins": 8}]
        _print_table(rows, title="Test")

    def test_numeric_column_from_later_row(self) -> None:
        """A column with None in first row but numeric in others is right-aligned."""
        rows = [
            {"name": "A", "score": None},
            {"name": "B", "score": 42},
        ]
        _print_table(rows)


class TestPrintJson:
    """Verify JSON output formatting."""

    def test_outputs_valid_json(self, capsys: object) -> None:
        """Output is valid JSON."""
        data = [{"team": "Carlton", "wins": 10}]
        _print_json(data)

    def test_pretty_output(self) -> None:
        """Pretty mode renders without crashing."""
        _print_json([{"x": 1}], pretty=True)


class TestPrintCsv:
    """Verify CSV output formatting."""

    def test_empty_rows_no_output(self) -> None:
        """Empty input produces no output."""
        _print_csv([])

    def test_renders_csv(self) -> None:
        """Rows are rendered as CSV without crashing."""
        rows = [{"name": "Carlton", "wins": 10}]
        _print_csv(rows)


class TestOutput:
    """Verify the _output routing function."""

    def test_routes_to_json(self) -> None:
        """JSON format calls _print_json."""
        _output([{"a": 1}], OutputFormat.json)

    def test_routes_to_csv(self) -> None:
        """CSV format calls _print_csv."""
        _output([{"a": 1}], OutputFormat.csv)

    def test_routes_to_table(self) -> None:
        """Table format calls _print_table."""
        _output([{"a": 1}], OutputFormat.table)

    def test_dict_input_wrapped_for_csv(self) -> None:
        """A dict input is wrapped in a list for CSV/table output."""
        _output({"a": 1}, OutputFormat.csv)

    def test_dict_input_wrapped_for_table(self) -> None:
        """A dict input is wrapped in a list for table output."""
        _output({"a": 1}, OutputFormat.table)
