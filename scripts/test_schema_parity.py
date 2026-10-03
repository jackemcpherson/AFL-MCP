"""Regression tests for schema and seed drift detection."""

import sqlite3
import unittest

from verify_schema_parity import ROOT, canonical_sql, snapshot


class SchemaParityTests(unittest.TestCase):
    """Check differences that the MCP schema documentation test cannot detect."""

    def setUp(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.addCleanup(self.database.close)
        self.database.executescript((ROOT / "src/db/schema.sql").read_text())

    def test_missing_integrity_view_changes_snapshot(self) -> None:
        before = snapshot(self.database)
        self.database.execute("DROP VIEW v_integrity_margin")
        self.assertNotEqual(before, snapshot(self.database))

    def test_missing_venue_coordinates_changes_snapshot(self) -> None:
        before = snapshot(self.database)
        self.database.execute("UPDATE venues SET latitude=NULL WHERE latitude IS NOT NULL")
        self.assertNotEqual(before, snapshot(self.database))

    def test_physical_column_order_does_not_change_definition(self) -> None:
        self.assertEqual(
            canonical_sql("CREATE TABLE example (x INTEGER, y TEXT)", is_table=True),
            canonical_sql('CREATE TABLE "example" (y TEXT, x INTEGER);', is_table=True),
        )

    def test_check_constraint_difference_changes_definition(self) -> None:
        self.assertNotEqual(
            canonical_sql("CREATE TABLE example (x INTEGER CHECK (x>0))", is_table=True),
            canonical_sql("CREATE TABLE example (x INTEGER CHECK (x>=0))", is_table=True),
        )


if __name__ == "__main__":
    unittest.main()
