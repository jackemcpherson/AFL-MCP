"""Compare consolidated schema, migrated schema, and required reference seeds."""

from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
IGNORED = {"d1_migrations", "_cf_KV"}
TOKEN = re.compile(r"--[^\n]*|/\*.*?\*/|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|\w+|[^\s]", re.S)


def canonical_sql(sql: str, *, is_table: bool = False) -> tuple[str, ...]:
    """Normalize formatting without changing literals, constraints, or key order."""
    tokens = []
    for token in TOKEN.findall(sql):
        if token.startswith(("--", "/*")) or token == ";":
            continue
        tokens.append(token if token.startswith("'") else token.strip('"').lower())
    if not is_table:
        return tuple(tokens)
    opening = tokens.index("(")
    groups: list[tuple[str, ...]] = []
    group: list[str] = []
    depth = 0
    for token in tokens[opening + 1 : -1]:
        if token == "," and depth == 0:
            groups.append(tuple(group))
            group = []
            continue
        depth += (token == "(") - (token == ")")
        group.append(token)
    groups.append(tuple(group))
    # Physical column order is not part of parameterized, named-column queries.
    return tuple(tokens[:opening]) + tuple(repr(part) for part in sorted(groups))


def snapshot(database: sqlite3.Connection) -> dict[str, object]:
    """Capture application DDL and seed rows, excluding SQLite/D1 bookkeeping."""
    result: dict[str, object] = {}
    rows = database.execute(
        "SELECT type,name,sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name"
    )
    for kind, name, sql in rows:
        if name in IGNORED:
            continue
        result[f"{kind}:{name}"] = canonical_sql(sql, is_table=kind == "table")
        if kind == "table":
            escaped = name.replace('"', '""')
            result[f"columns:{name}"] = sorted(
                tuple(column[1:])
                for column in database.execute(f'PRAGMA table_xinfo("{escaped}")')
            )
            result[f"foreign_keys:{name}"] = sorted(
                tuple(key[2:])
                for key in database.execute(f'PRAGMA foreign_key_list("{escaped}")')
            )
    result["seed:competitions"] = list(database.execute("SELECT code,name FROM competitions ORDER BY code"))
    result["seed:venues"] = list(database.execute(
        "SELECT v.name,v.latitude,v.longitude,v.timezone,v.roof,c.name "
        "FROM venues v LEFT JOIN venues c ON c.id=v.canonical_venue_id ORDER BY v.name"
    ))
    result["seed:sync_lease"] = list(database.execute("SELECT id,holder,acquired_at FROM sync_lease ORDER BY id"))
    result["seed:public_input_revision"] = list(database.execute(
        "SELECT revision,in_progress,write_started_at FROM public_input_revision WHERE id=1"
    ))
    return result


def main() -> None:
    """Fail CI when a consolidated object, constraint, or seed differs."""
    with sqlite3.connect(":memory:") as migrated, sqlite3.connect(":memory:") as consolidated:
        migrated.execute("PRAGMA foreign_keys=ON")
        consolidated.execute("PRAGMA foreign_keys=ON")
        migrated.execute("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)")
        for migration in sorted((ROOT / "src/db/migrations").glob("*.sql")):
            migrated.executescript(migration.read_text())
            migrated.execute("INSERT INTO d1_migrations(name) VALUES (?)", (migration.name,))
        consolidated.executescript((ROOT / "src/db/schema.sql").read_text())
        left, right = snapshot(migrated), snapshot(consolidated)
        differences = sorted(key for key in left.keys() | right.keys() if left.get(key) != right.get(key))
        if differences:
            raise SystemExit("Schema parity failed: " + ", ".join(differences))
        for database in (migrated, consolidated):
            if list(database.execute("PRAGMA foreign_key_check")):
                raise SystemExit("Reference seed contains invalid foreign keys")
        print(f"Schema parity passed: {len(left)} comparisons, {len(left['seed:venues'])} venue seeds")


if __name__ == "__main__":
    main()
