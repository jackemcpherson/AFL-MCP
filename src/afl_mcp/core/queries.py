"""Read-only SQL query execution with safety guards.

Provides parameterised query execution with two-layer read-only
enforcement: regex validation at the application layer and
PostgreSQL session-level read-only mode at the connection layer.
"""

from __future__ import annotations

import re

from afl_mcp.core.db import get_pool

_FORBIDDEN_PATTERN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b",
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
        cur = conn.execute(sql, params)
        if cur.description is None:
            return []
        return cur.fetchall()


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
