"""Tests for loader CSV parsing and name normalisation helpers.

These are pure functions with no database dependency, testing the
data transformation logic that maps raw CSV values to database types.
"""

from __future__ import annotations

from pathlib import Path


from unittest.mock import MagicMock, patch

from afl_mcp.core.loader import (
    TEAM_NAME_MAP,
    VENUE_NAME_MAP,
    _bool_from_str,
    _detect_source_files,
    _float_or_none,
    _int_or_none,
    _is_afl_api_id,
    _normalise_team,
    _normalise_venue,
    _str_or_none,
    check_freshness,
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
        """All source GWS names map to 'GWS Giants'."""
        assert _normalise_team("Greater Western Sydney") == "GWS Giants"
        assert _normalise_team("GWS") == "GWS Giants"
        assert _normalise_team("GWS GIANTS") == "GWS Giants"

    def test_footscray_maps_to_western_bulldogs(self) -> None:
        """Historical name maps to current name."""
        assert _normalise_team("Footscray") == "Western Bulldogs"

    def test_brisbane_bears_maps_to_lions(self) -> None:
        """Defunct team maps to successor."""
        assert _normalise_team("Brisbane Bears") == "Brisbane Lions"

    def test_afl_api_team_variants(self) -> None:
        """AFL API full team names map to short canonical names."""
        assert _normalise_team("Sydney Swans") == "Sydney"
        assert _normalise_team("Geelong Cats") == "Geelong"
        assert _normalise_team("Adelaide Crows") == "Adelaide"
        assert _normalise_team("West Coast Eagles") == "West Coast"
        assert _normalise_team("Gold Coast SUNS") == "Gold Coast"

    def test_footywire_brisbane_maps_to_lions(self) -> None:
        """FootyWire's 'Brisbane' maps to 'Brisbane Lions'."""
        assert _normalise_team("Brisbane") == "Brisbane Lions"

    def test_leading_whitespace_stripped(self) -> None:
        """Leading/trailing whitespace is stripped before lookup."""
        assert _normalise_team(" GWS ") == "GWS Giants"
        assert _normalise_venue(" MCG") == "MCG"
        assert _normalise_venue(" ENGIE Stadium ") == "Sydney Showground"

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

    def test_afl_api_venue_variants(self) -> None:
        """AFL API venue names map to canonical names."""
        assert _normalise_venue("Corroboree Group Oval Manuka") == "Manuka Oval"
        assert _normalise_venue("TIO Traeger Park") == "Traeger Park"

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


class TestSourceFileDetection:
    """Verify source file detection picks up the right files."""

    def test_detects_afl_files(self, tmp_path: Path) -> None:
        """AFL API files are detected correctly."""
        (tmp_path / "results_afl.csv").touch()
        (tmp_path / "player_stats_afl.csv").touch()
        files = _detect_source_files(tmp_path)
        assert "results_afl" in files
        assert "stats_afl" in files

    def test_detects_legacy_files(self, tmp_path: Path) -> None:
        """Legacy files are detected correctly."""
        (tmp_path / "results.csv").touch()
        (tmp_path / "player_stats.csv").touch()
        files = _detect_source_files(tmp_path)
        assert "results_legacy" in files
        assert "stats_legacy" in files

    def test_detects_all_sources(self, tmp_path: Path) -> None:
        """All source types detected when present."""
        (tmp_path / "results_afl.csv").touch()
        (tmp_path / "results_footywire.csv").touch()
        (tmp_path / "results.csv").touch()
        (tmp_path / "player_stats_afl.csv").touch()
        (tmp_path / "player_stats_fryzigg.csv").touch()
        (tmp_path / "player_stats.csv").touch()
        files = _detect_source_files(tmp_path)
        assert len(files) == 6

    def test_empty_directory(self, tmp_path: Path) -> None:
        """Empty directory returns no files."""
        files = _detect_source_files(tmp_path)
        assert len(files) == 0

    def test_ignores_unrelated_files(self, tmp_path: Path) -> None:
        """Non-matching CSV files are ignored."""
        (tmp_path / "players.csv").touch()
        (tmp_path / "random.csv").touch()
        files = _detect_source_files(tmp_path)
        assert len(files) == 0


def _write_results_csv(path: Path, dates: list[str]) -> None:
    """Write a minimal results CSV with the given match dates."""
    with open(path, "w") as f:
        f.write("Date,Home.Team,Away.Team,Venue,Round,Home.Points,Away.Points\n")
        for d in dates:
            f.write(f"{d},Richmond,Carlton,MCG,R1,100,80\n")


def _mock_pool_with_max_date(
    max_date: str | None,
    year_counts: dict[str, int] | None = None,
) -> MagicMock:
    """Build a mock pool whose connection returns the given max date and counts.

    Args:
        max_date: Value for ``SELECT MAX(date) FROM matches``.
        year_counts: Mapping of year string to match count for the
            per-year count query.  Defaults to empty if *max_date* is None.
    """
    if year_counts is None:
        year_counts = {}

    max_date_cursor = MagicMock()
    max_date_cursor.fetchone.return_value = {"max": max_date}

    year_count_rows = [{"year": y, "cnt": c} for y, c in year_counts.items()]
    year_count_cursor = MagicMock()
    year_count_cursor.fetchall.return_value = year_count_rows

    mock_conn = MagicMock()
    mock_conn.execute.side_effect = [max_date_cursor, year_count_cursor]

    mock_pool = MagicMock()
    mock_pool.connection.return_value.__enter__ = lambda _: mock_conn
    mock_pool.connection.return_value.__exit__ = MagicMock(return_value=False)
    return mock_pool


class TestCheckFreshness:
    """Verify freshness check compares CSV dates against the database."""

    @patch("afl_mcp.core.db.get_pool")
    def test_new_data_when_csv_newer(
        self, mock_get_pool: MagicMock, tmp_path: Path
    ) -> None:
        """CSV with a newer date signals new data available."""
        _write_results_csv(tmp_path / "results.csv", ["2026-03-15", "2026-03-22"])
        mock_get_pool.return_value = _mock_pool_with_max_date(
            "2026-03-15", {"2026": 1}
        )

        result = check_freshness(tmp_path)
        assert result["has_new_data"] is True
        assert result["csv_latest_date"] == "2026-03-22"
        assert result["db_latest_date"] == "2026-03-15"

    @patch("afl_mcp.core.db.get_pool")
    def test_no_new_data_when_dates_and_counts_equal(
        self, mock_get_pool: MagicMock, tmp_path: Path
    ) -> None:
        """CSV with same latest date and match count as DB signals no new data."""
        _write_results_csv(tmp_path / "results.csv", ["2026-03-15"])
        mock_get_pool.return_value = _mock_pool_with_max_date(
            "2026-03-15", {"2026": 1}
        )

        result = check_freshness(tmp_path)
        assert result["has_new_data"] is False

    @patch("afl_mcp.core.db.get_pool")
    def test_new_data_when_csv_has_more_matches(
        self, mock_get_pool: MagicMock, tmp_path: Path
    ) -> None:
        """CSV with same latest date but more matches signals new data.

        This covers the gap scenario where the DB loaded later games
        before an earlier game appeared in the source (e.g. a Thursday
        night opener that fitzRoy published after Friday/Saturday games).
        """
        _write_results_csv(
            tmp_path / "results.csv",
            ["2026-03-19", "2026-03-20", "2026-03-22"],
        )
        # DB has same latest date but only 2 of the 3 matches.
        mock_get_pool.return_value = _mock_pool_with_max_date(
            "2026-03-22", {"2026": 2}
        )

        result = check_freshness(tmp_path)
        assert result["has_new_data"] is True
        assert "3 matches" in result["reason"]
        assert "2 " in result["reason"]

    @patch("afl_mcp.core.db.get_pool")
    def test_new_data_when_db_empty(
        self, mock_get_pool: MagicMock, tmp_path: Path
    ) -> None:
        """Empty database always signals new data."""
        _write_results_csv(tmp_path / "results.csv", ["2026-03-15"])
        mock_get_pool.return_value = _mock_pool_with_max_date(None)

        result = check_freshness(tmp_path)
        assert result["has_new_data"] is True
        assert result["reason"] == "Database is empty"

    def test_no_csv_files(self, tmp_path: Path) -> None:
        """No CSV files returns no new data without querying DB."""
        result = check_freshness(tmp_path)
        assert result["has_new_data"] is False
        assert "No CSV files" in str(result["reason"])


class TestIsAflApiId:
    """Verify AFL API player ID detection."""

    def test_cd_i_prefix_is_afl(self) -> None:
        """CD_I prefixed IDs are AFL API IDs."""
        assert _is_afl_api_id("CD_I291776") is True

    def test_bare_numeric_is_not_afl(self) -> None:
        """Bare numeric IDs (fryzigg) are not AFL API IDs."""
        assert _is_afl_api_id("12070") is False

    def test_empty_string_is_not_afl(self) -> None:
        """Empty string is not an AFL API ID."""
        assert _is_afl_api_id("") is False

    def test_cd_m_prefix_is_not_player(self) -> None:
        """CD_M (match) prefix is not a player ID."""
        assert _is_afl_api_id("CD_M20260101001") is False
