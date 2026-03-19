"""Database connection pool and migration runner.

Provides a singleton read-only connection pool for query execution,
a writable admin connection for migrations and data loading, and a
simple file-based migration runner.
"""

from __future__ import annotations

import atexit
import logging
import os
import threading
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

__all__ = [
    "get_pool",
    "get_admin_connection",
    "run_migrations",
    "close_pool",
]

logger = logging.getLogger(__name__)

_pool: ConnectionPool | None = None  # type: ignore[type-arg]
_pool_lock = threading.Lock()

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "db" / "migrations"


def _get_dsn() -> str:
    """Read the DATABASE_URL from the environment.

    Returns:
        The PostgreSQL connection string.

    Raises:
        RuntimeError: If DATABASE_URL is not set.
    """
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError(
            "DATABASE_URL environment variable is not set. "
            "Copy .env.example to .env and configure your database connection."
        )
    return dsn


def _configure_pool_connection(conn: psycopg.Connection[dict]) -> None:
    """Configure each pool connection with read-only mode, timeout, and pgvector.

    Args:
        conn: The psycopg connection to configure.
    """
    conn.autocommit = True
    conn.execute("SET default_transaction_read_only = on")
    conn.execute("SET statement_timeout = 30000")
    try:
        from pgvector.psycopg import register_vector

        register_vector(conn)
    except ImportError:
        logger.debug("pgvector not installed, skipping vector type registration")
    conn.autocommit = False


def get_pool() -> ConnectionPool:
    """Return a singleton read-only connection pool.

    Creates the pool on first call, loading environment variables from
    a .env file if present. Registers an atexit handler for cleanup.

    Returns:
        The shared ConnectionPool instance.
    """
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                from dotenv import load_dotenv

                load_dotenv()

                _pool = ConnectionPool(  # type: ignore[assignment]
                    _get_dsn(),
                    min_size=1,
                    max_size=5,
                    configure=_configure_pool_connection,
                    kwargs={"row_factory": dict_row},
                )
                atexit.register(close_pool)
    return _pool  # type: ignore[return-value]


def get_admin_connection() -> psycopg.Connection[dict]:
    """Return a writable connection for migrations and data loading.

    Callers must use this as a context manager to ensure cleanup.

    Returns:
        A psycopg Connection with dict row factory.
    """
    from dotenv import load_dotenv

    load_dotenv()

    conn = psycopg.connect(
        _get_dsn(),
        row_factory=dict_row,
        connect_timeout=30,
    )
    conn.execute("SET statement_timeout = 300000")  # 5 minutes
    return conn  # type: ignore[return-value]


def run_migrations() -> list[str]:
    """Apply pending SQL migrations from db/migrations/ in order.

    Reads SQL files sorted by their numeric prefix (e.g. 001_, 002_),
    skips already-applied versions tracked in schema_migrations, and
    applies each remaining migration in its own committed transaction.

    Each migration file may contain multiple SQL statements separated
    by semicolons. Statements are executed individually within a single
    transaction.

    Returns:
        List of filenames that were applied.
    """
    applied: list[str] = []

    with get_admin_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version     INTEGER PRIMARY KEY,
                filename    TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.commit()

        rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
        applied_versions = {row["version"] for row in rows}

        migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))

        for migration_file in migration_files:
            version = int(migration_file.name.split("_")[0])
            if version in applied_versions:
                continue

            sql = migration_file.read_text()
            # Execute each statement separately so multi-statement
            # migration files work correctly with psycopg3.
            for statement in sql.split(";"):
                statement = statement.strip()
                if statement:
                    conn.execute(statement)  # type: ignore[arg-type]
            conn.execute(
                "INSERT INTO schema_migrations (version, filename) VALUES (%s, %s)",
                (version, migration_file.name),
            )
            conn.commit()
            applied.append(migration_file.name)
            logger.info("Applied migration: %s", migration_file.name)

    return applied


def close_pool() -> None:
    """Close the connection pool if open."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
