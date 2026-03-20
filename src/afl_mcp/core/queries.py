"""Read-only SQL query execution with safety guards.

Provides parameterised query execution with two-layer read-only
enforcement: regex validation at the application layer and
PostgreSQL session-level read-only mode at the connection layer.
"""

from __future__ import annotations

import re

from afl_mcp.core.db import get_pool

__all__ = [
    "execute_query",
    "get_schema_info",
    "get_foreign_keys",
    "get_schema_dict",
    "get_last_updated",
]

# Application-layer regex guard for write operations.
#
# Known limitations — this regex cannot detect:
# - Keywords hidden inside string literals (e.g. WHERE note = 'DELETE ME')
#   This is a known false positive — intentionally conservative.
# - CTEs that wrap write operations (WITH x AS (DELETE ...))
#   The CTE case is caught because DELETE itself is still present.
#
# The PostgreSQL session-level read-only mode
# (SET default_transaction_read_only = on) is the authoritative guard.
# This regex is a defence-in-depth layer that catches obvious mistakes
# before they reach the database.
_FORBIDDEN_PATTERN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY)\b",
    re.IGNORECASE,
)


def execute_query(sql: str, params: tuple | list | None = None) -> list[dict]:
    """Execute a read-only SQL query and return results as dicts.

    Args:
        sql: The SQL SELECT query to execute.
        params: Optional query parameters for parameterised queries.

    Returns:
        List of dicts, one per result row.

    Raises:
        ValueError: If the query contains a forbidden write statement.
    """
    if _FORBIDDEN_PATTERN.search(sql):
        raise ValueError(
            "Query contains a forbidden statement. Only SELECT queries are allowed."
        )

    pool = get_pool()
    with pool.connection() as conn:
        cur = conn.execute(sql, params)  # type: ignore[arg-type]
        if cur.description is None:
            return []
        return cur.fetchall()  # type: ignore[return-value]


def get_schema_info(table_name: str | None = None) -> list[dict]:
    """Return column metadata from information_schema.

    Args:
        table_name: If provided, returns columns for that table only.
            Otherwise returns columns for all public tables.

    Returns:
        List of dicts with table_name, column_name, data_type, etc.
    """
    if table_name:
        return execute_query(
            """SELECT table_name, column_name, data_type, is_nullable,
                      column_default
               FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = %s
               ORDER BY ordinal_position""",
            (table_name,),
        )
    return execute_query(
        """SELECT table_name, column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name NOT LIKE 'pg_%%'
           ORDER BY table_name, ordinal_position"""
    )


def get_foreign_keys() -> list[dict]:
    """Return foreign key relationships in the public schema.

    Returns:
        List of dicts with table_name, column_name,
        foreign_table_name, and foreign_column_name.
    """
    return execute_query(
        """SELECT
               tc.table_name,
               kcu.column_name,
               ccu.table_name AS foreign_table_name,
               ccu.column_name AS foreign_column_name
           FROM information_schema.table_constraints AS tc
           JOIN information_schema.key_column_usage AS kcu
               ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage AS ccu
               ON ccu.constraint_name = tc.constraint_name
               AND ccu.table_schema = tc.table_schema
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_schema = 'public'
           ORDER BY tc.table_name"""
    )


def get_schema_dict(table_name: str | None = None) -> dict:
    """Return schema info as a dict with columns and optional foreign keys.

    Shared by the MCP server and CLI to avoid duplicating assembly logic.
    """
    result: dict = {"columns": get_schema_info(table_name)}
    if not table_name:
        result["foreign_keys"] = get_foreign_keys()
    return result


def get_last_updated() -> dict:
    """Return data freshness metadata.

    Queries the database for the most recent match, player stats,
    season range, row counts, and PAV availability.

    Returns:
        Dict with freshness metadata matching the get_last_updated
        tool specification.
    """
    rows = execute_query(
        """WITH latest_match AS (
                SELECT m.date, m.round,
                       ht.name || ' vs ' || at.name AS description
                FROM matches m
                JOIN teams ht ON ht.id = m.home_team_id
                JOIN teams at ON at.id = m.away_team_id
                ORDER BY m.date DESC
                LIMIT 1
            ),
            latest_stats AS (
                SELECT m.date, m.round,
                       ht.name || ' vs ' || at.name AS description
                FROM matches m
                JOIN teams ht ON ht.id = m.home_team_id
                JOIN teams at ON at.id = m.away_team_id
                WHERE EXISTS (
                    SELECT 1 FROM player_match_stats pms
                    WHERE pms.match_id = m.id
                )
                ORDER BY m.date DESC
                LIMIT 1
            ),
            season_range AS (
                SELECT MIN(year) AS min_year, MAX(year) AS max_year
                FROM seasons
            ),
            pav_range AS (
                SELECT MIN(s.year) AS min_year, MAX(s.year) AS max_year
                FROM player_season_pav psp
                JOIN seasons s ON s.id = psp.season_id
            )
            SELECT
                lm.date AS latest_match_date,
                lm.round AS latest_match_round,
                lm.description AS latest_match_description,
                ls.date AS latest_stats_date,
                ls.round AS latest_stats_round,
                ls.description AS latest_stats_description,
                sr.min_year AS min_season,
                sr.max_year AS max_season,
                (SELECT COUNT(*)::int FROM matches) AS total_matches,
                (SELECT COUNT(*)::int FROM players) AS total_players,
                (SELECT COUNT(*)::int FROM player_match_stats) AS total_stat_rows,
                pr.min_year AS pav_from,
                pr.max_year AS pav_to
            FROM latest_match lm
            CROSS JOIN latest_stats ls
            CROSS JOIN season_range sr
            CROSS JOIN pav_range pr"""
    )

    if not rows:
        return {}

    row = rows[0]

    return {
        "latest_season": row["max_season"],
        "latest_match": {
            "date": str(row["latest_match_date"]) if row["latest_match_date"] else None,
            "round": row["latest_match_round"],
            "description": row["latest_match_description"],
        },
        "latest_player_stats": {
            "date": str(row["latest_stats_date"]) if row["latest_stats_date"] else None,
            "round": row["latest_stats_round"],
            "description": row["latest_stats_description"],
        },
        "seasons_available": {
            "from": row["min_season"],
            "to": row["max_season"],
        },
        "total_matches": row["total_matches"],
        "total_players": row["total_players"],
        "total_stat_rows": row["total_stat_rows"],
        "pav_available": {
            "from": row["pav_from"],
            "to": row["pav_to"],
        },
    }
