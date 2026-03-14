"""Tests for loader CSV parsing and name normalisation helpers.

These are pure functions with no database dependency, testing the
data transformation logic that maps raw CSV values to database types.
"""

from __future__ import annotations

import pytest

from afl_mcp.core.loader import (
    TEAM_NAME_MAP,
    VENUE_NAME_MAP,
    _bool_from_str,
    _float_or_none,
    _int_or_none,
    _normalise_team,
    _normalise_venue,
    _str_or_none,
)


class TestIntOrNone:
    """Verify integer parsing from CSV string values."""

    def test_valid_integer(self) -> None:
        """Standard integer strings parse correctly."""
        assert _int_or_none("42") == 42

    def test_float_string_truncates(self) -> None:
        """Float strings are truncated to int (CSV sometimes has '3.0')."""
        assert _int_or_none("3.0") == 3

    def test_empty_string_returns_none(self) -> None:
        """Empty CSV cells produce None."""
        assert _int_or_none("") is None

    def test_na_returns_none(self) -> None:
        """R's NA sentinel produces None."""
        assert _int_or_none("NA") is None

    def test_false_returns_none(self) -> None:
        """Boolean strings from R are not valid integers."""
        assert _int_or_none("FALSE") is None

    def test_true_returns_none(self) -> None:
        """Boolean strings from R are not valid integers."""
        assert _int_or_none("TRUE") is None

    def test_non_numeric_returns_none(self) -> None:
        """Garbage strings produce None without raising."""
        assert _int_or_none("abc") is None

    def test_negative_integer(self) -> None:
        """Negative values (e.g. margins) parse correctly."""
        assert _int_or_none("-15") == -15

    def test_zero(self) -> None:
        """Zero is a valid integer, not treated as falsy."""
        assert _int_or_none("0") == 0


class TestFloatOrNone:
    """Verify float parsing from CSV string values."""

    def test_valid_float(self) -> None:
        """Standard float strings parse correctly."""
        assert _float_or_none("73.5") == 73.5

    def test_integer_string(self) -> None:
        """Integer strings are valid floats."""
        assert _float_or_none("42") == 42.0

    def test_empty_string_returns_none(self) -> None:
        """Empty CSV cells produce None."""
        assert _float_or_none("") is None

    def test_na_returns_none(self) -> None:
        """R's NA sentinel produces None."""
        assert _float_or_none("NA") is None

    def test_boolean_strings_return_none(self) -> None:
        """Boolean strings are rejected consistently with _int_or_none."""
        assert _float_or_none("FALSE") is None
        assert _float_or_none("TRUE") is None

    def test_non_numeric_returns_none(self) -> None:
        """Garbage strings produce None without raising."""
        assert _float_or_none("abc") is None


class TestStrOrNone:
    """Verify string cleaning from CSV values."""

    def test_normal_string_passes_through(self) -> None:
        """Regular strings are returned unchanged."""
        assert _str_or_none("Richmond") == "Richmond"

    def test_empty_string_returns_none(self) -> None:
        """Empty CSV cells produce None."""
        assert _str_or_none("") is None

    def test_na_returns_none(self) -> None:
        """R's NA sentinel produces None."""
        assert _str_or_none("NA") is None


class TestBoolFromStr:
    """Verify boolean parsing from R's TRUE/FALSE strings."""

    def test_true_string(self) -> None:
        """R's TRUE produces Python True."""
        assert _bool_from_str("TRUE") is True

    def test_false_string(self) -> None:
        """R's FALSE produces Python False."""
        assert _bool_from_str("FALSE") is False

    def test_case_insensitive(self) -> None:
        """Mixed case is handled."""
        assert _bool_from_str("true") is True
        assert _bool_from_str("False") is False

    def test_empty_returns_none(self) -> None:
        """Empty values produce None."""
        assert _bool_from_str("") is None

    def test_na_returns_none(self) -> None:
        """R's NA produces None."""
        assert _bool_from_str("NA") is None


class TestTeamNormalisation:
    """Verify team name mapping from source variations to canonical names."""

    def test_gws_variants(self) -> None:
        """Both afltables and fryzigg GWS names map to 'GWS Giants'."""
        assert _normalise_team("Greater Western Sydney") == "GWS Giants"
        assert _normalise_team("GWS") == "GWS Giants"

    def test_footscray_maps_to_western_bulldogs(self) -> None:
        """Historical name maps to current name."""
        assert _normalise_team("Footscray") == "Western Bulldogs"

    def test_brisbane_bears_maps_to_lions(self) -> None:
        """Defunct team maps to successor."""
        assert _normalise_team("Brisbane Bears") == "Brisbane Lions"

    def test_unmapped_name_passes_through(self) -> None:
        """Teams not in the map are returned unchanged."""
        assert _normalise_team("Carlton") == "Carlton"
        assert _normalise_team("Richmond") == "Richmond"

    def test_all_mapped_values_are_consistent(self) -> None:
        """Every mapping produces a name that is itself a stable canonical form."""
        for canonical in TEAM_NAME_MAP.values():
            result = _normalise_team(canonical)
            assert result == canonical, (
                f"Canonical name '{canonical}' re-normalises to '{result}'"
            )


class TestVenueNormalisation:
    """Verify venue name mapping from source variations to canonical names."""

    def test_mcg_variants(self) -> None:
        """afltables 'M.C.G.' maps to 'MCG'."""
        assert _normalise_venue("M.C.G.") == "MCG"

    def test_docklands_maps_to_marvel(self) -> None:
        """Old name maps to current name."""
        assert _normalise_venue("Docklands") == "Marvel Stadium"
        assert _normalise_venue("Etihad Stadium") == "Marvel Stadium"

    def test_gabba_variants(self) -> None:
        """'The Gabba' and 'Gabba' both map to 'Gabba'."""
        assert _normalise_venue("The Gabba") == "Gabba"
        assert _normalise_venue("Gabba") == "Gabba"

    def test_carrara_variants(self) -> None:
        """Gold Coast's ground has had many names."""
        assert _normalise_venue("Metricon Stadium") == "Carrara"
        assert _normalise_venue("People First Stadium") == "Carrara"
        assert _normalise_venue("Heritage Bank Stadium") == "Carrara"

    def test_unmapped_venue_passes_through(self) -> None:
        """Venues not in the map are returned unchanged."""
        assert _normalise_venue("Adelaide Oval") == "Adelaide Oval"

    def test_all_mapped_values_are_stable(self) -> None:
        """Every canonical venue name re-normalises to itself."""
        canonical_names = set(VENUE_NAME_MAP.values())
        for canonical in canonical_names:
            result = _normalise_venue(canonical)
            assert result == canonical, (
                f"Canonical venue '{canonical}' re-normalises to '{result}'"
            )
