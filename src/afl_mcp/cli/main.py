"""AFL-MCP command-line interface.

Provides commands for querying the AFL database, running semantic
search, checking data freshness, inspecting the schema, managing
database operations, and starting the MCP server.
"""

from __future__ import annotations

import csv as csv_lib
import io
import json as json_lib
import logging
from enum import Enum
from typing import Annotated

import typer
from rich.console import Console
from rich.json import JSON
from rich.table import Table

logger = logging.getLogger(__name__)

app = typer.Typer(
    help="[bold]AFL-MCP[/bold] — AFL statistics from the command line.",
    rich_markup_mode="rich",
    no_args_is_help=True,
)
db_app = typer.Typer(
    help="Database management commands.",
    rich_markup_mode="rich",
    no_args_is_help=True,
)
app.add_typer(db_app, name="db")

console = Console()


class Transport(str, Enum):
    """MCP transport protocol options."""

    stdio = "stdio"
    sse = "sse"
    streamable_http = "streamable-http"


class OutputFormat(str, Enum):
    """CLI output format options."""

    json = "json"
    table = "table"
    csv = "csv"


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def _is_numeric(value: object) -> bool:
    """Check whether a value looks numeric for table column alignment."""
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        try:
            float(value)
            return True
        except ValueError:
            return False
    return False


def _print_table(rows: list[dict], title: str | None = None) -> None:
    """Render a list of dicts as a Rich table."""
    if not rows:
        console.print("[dim]No results.[/dim]")
        return

    table = Table(
        title=title,
        show_header=True,
        header_style="bold cyan",
        row_styles=["", "dim"],
        border_style="bright_black",
        title_style="bold",
    )

    keys = list(rows[0].keys())
    numeric_cols = {k for k in keys if _is_numeric(rows[0][k])}

    for key in keys:
        justify = "right" if key in numeric_cols else "left"
        table.add_column(key, justify=justify)

    for row in rows:
        table.add_row(*(str(v) if v is not None else "" for v in row.values()))

    console.print(table)


def _print_json(data: list[dict] | dict, pretty: bool = False) -> None:
    """Print results as JSON."""
    if pretty:
        console.print(JSON(json_lib.dumps(data, indent=2, default=str)))
    else:
        console.print(json_lib.dumps(data, default=str))


def _print_csv(rows: list[dict]) -> None:
    """Print results as CSV."""
    if not rows:
        return
    output = io.StringIO()
    writer = csv_lib.DictWriter(output, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
    console.print(output.getvalue(), end="")


def _output(
    data: list[dict] | dict,
    fmt: OutputFormat,
    pretty: bool = False,
    title: str | None = None,
) -> None:
    """Route output to the appropriate formatter."""
    if fmt == OutputFormat.json:
        _print_json(data, pretty)
    elif fmt == OutputFormat.csv:
        rows = data if isinstance(data, list) else [data]
        _print_csv(rows)
    else:
        rows = data if isinstance(data, list) else [data]
        _print_table(rows, title=title)


# ---------------------------------------------------------------------------
# Database management commands
# ---------------------------------------------------------------------------


@db_app.command()
def migrate() -> None:
    """Apply pending database migrations."""
    from afl_mcp.core.db import run_migrations

    applied = run_migrations()
    if applied:
        console.print(f"[green]Applied {len(applied)} migration(s):[/green]")
        for name in applied:
            console.print(f"  [green]\u2713[/green] {name}")
    else:
        console.print("[yellow]No pending migrations.[/yellow]")


@db_app.command()
def load(
    data_dir: Annotated[
        str,
        typer.Option("--data-dir", "-d", help="Directory containing CSV files."),
    ] = "data/raw",
) -> None:
    """Load CSV data from fitzRoy exports into PostgreSQL."""
    from afl_mcp.core.loader import load_all

    with console.status("[bold]Loading data...", spinner="dots"):
        counts = load_all(data_dir)

    _print_table(
        [{"table": k, "rows": v} for k, v in counts.items()],
        title="Load Summary",
    )


@db_app.command()
def embed(
    incremental: Annotated[
        bool,
        typer.Option("--incremental", "-i", help="Only embed new/updated rows."),
    ] = False,
) -> None:
    """Generate vector embeddings for semantic search."""
    if incremental:
        from afl_mcp.core.embeddings import generate_incremental_embeddings

        label = "Generating incremental embeddings..."
        generate = generate_incremental_embeddings
    else:
        from afl_mcp.core.embeddings import generate_all_embeddings

        label = "Generating embeddings..."
        generate = generate_all_embeddings

    with console.status(f"[bold]{label}", spinner="dots"):
        counts = generate()

    _print_table(
        [{"table": k, "count": v} for k, v in counts.items()],
        title="Embedding Summary",
    )


@db_app.command()
def pav(
    year: Annotated[
        int | None,
        typer.Option("--year", "-y", help="Season year (omit for all 1998+)."),
    ] = None,
) -> None:
    """Calculate and store PAV (Player Approximate Value) ratings."""
    if year is not None:
        from afl_mcp.core.pav import calculate_pav

        try:
            with console.status(f"[bold]Calculating PAV for {year}...", spinner="dots"):
                count = calculate_pav(year)
            console.print(f"[green]Calculated PAV for {year}: {count} players[/green]")
        except ValueError as e:
            console.print(f"[red]Error:[/red] {e}")
            raise typer.Exit(code=1)
    else:
        from afl_mcp.core.pav import calculate_all_pav

        with console.status("[bold]Calculating PAV for all seasons...", spinner="dots"):
            results = calculate_all_pav()

        _print_table(
            [{"year": k, "players": v} for k, v in results.items()],
            title="PAV Calculation Summary",
        )


@db_app.command(name="check-freshness")
def check_freshness_cmd(
    data_dir: Annotated[
        str,
        typer.Option("--data-dir", "-d", help="Directory containing CSV files."),
    ] = "data/raw",
) -> None:
    """Check if extracted CSVs contain data newer than the database.

    Exits with code 0 if new data is available (proceed with load),
    or code 1 if the database is already up to date (skip load).
    """
    from afl_mcp.core.loader import check_freshness

    result = check_freshness(data_dir)
    has_new_data = result["has_new_data"]

    if has_new_data:
        console.print(f"[green]New data available:[/green] {result['reason']}")
    else:
        console.print(f"[yellow]Already fresh:[/yellow] {result['reason']}")

    raise typer.Exit(code=0 if has_new_data else 1)


def _sql_impl(
    sql: str,
    fmt: OutputFormat = OutputFormat.table,
    pretty: bool = False,
) -> None:
    """Shared implementation for sql / execute-sql commands."""
    from afl_mcp.core.queries import execute_query

    try:
        results = execute_query(sql)
    except ValueError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1)

    _output(results, fmt, pretty)


@app.command(name="sql")
def sql_cmd(
    sql: Annotated[
        str,
        typer.Option("--query", "-q", help="SQL SELECT query to execute."),
    ],
    fmt: Annotated[
        OutputFormat,
        typer.Option("--format", "-f", help="Output format."),
    ] = OutputFormat.table,
    pretty: Annotated[
        bool,
        typer.Option("--pretty", "-p", help="Pretty-print JSON output."),
    ] = False,
) -> None:
    """Execute a read-only SQL query against the AFL database."""
    _sql_impl(sql, fmt, pretty)


@app.command(name="execute-sql", hidden=True)
def execute_sql_cmd(
    sql: Annotated[
        str,
        typer.Option("--sql", help="SQL SELECT query to execute."),
    ],
    fmt: Annotated[
        OutputFormat,
        typer.Option("--format", "-f", help="Output format."),
    ] = OutputFormat.table,
    pretty: Annotated[
        bool,
        typer.Option("--pretty", "-p", help="Pretty-print JSON output."),
    ] = False,
) -> None:
    """Execute a read-only SQL query (alias for sql)."""
    _sql_impl(sql, fmt, pretty)


def _schema_impl(
    table_name: str | None = None,
    fmt: OutputFormat = OutputFormat.table,
    pretty: bool = False,
) -> None:
    """Shared implementation for schema / get-schema commands."""
    from afl_mcp.core.queries import get_schema_dict

    result = get_schema_dict(table_name)

    if fmt == OutputFormat.table:
        title = f"Schema: {table_name}" if table_name else "Database Schema"
        _print_table(result["columns"], title=title)
        fks = result.get("foreign_keys")
        if fks:
            _print_table(fks, title="Foreign Keys")
    else:
        _output(result, fmt, pretty)


@app.command(name="schema")
def schema_cmd(
    table_name: Annotated[
        str | None,
        typer.Option("--table", "-t", help="Table name to inspect. Omit for all."),
    ] = None,
    fmt: Annotated[
        OutputFormat,
        typer.Option("--format", "-f", help="Output format."),
    ] = OutputFormat.table,
    pretty: Annotated[
        bool,
        typer.Option("--pretty", "-p", help="Pretty-print JSON output."),
    ] = False,
) -> None:
    """Show database schema -- tables, columns, types, and foreign keys."""
    _schema_impl(table_name, fmt, pretty)


@app.command(name="get-schema", hidden=True)
def get_schema_cmd(
    table_name: Annotated[
        str | None,
        typer.Option("--table", help="Table name to inspect. Omit for all."),
    ] = None,
    fmt: Annotated[
        OutputFormat,
        typer.Option("--format", "-f", help="Output format."),
    ] = OutputFormat.table,
    pretty: Annotated[
        bool,
        typer.Option("--pretty", "-p", help="Pretty-print JSON output."),
    ] = False,
) -> None:
    """Show database schema (alias for schema)."""
    _schema_impl(table_name, fmt, pretty)


def _ladder_impl(
    year: int,
    round_number: int | None = None,
    fmt: OutputFormat = OutputFormat.table,
    pretty: bool = False,
) -> None:
    """Shared implementation for ladder / get-ladder commands."""
    from afl_mcp.core.tools import get_ladder

    title = f"{year} Ladder"
    if round_number is not None:
        title += f" (Round {round_number})"
    results = get_ladder(year, round_number)
    _output(results, fmt, pretty, title=title)


@app.command(name="ladder")
def ladder_cmd(
    year: Annotated[
        int,
        typer.Option("--year", "-y", help="Season year."),
    ],
    round_number: Annotated[
        int | None,
        typer.Option("--round", "-r", help="Ladder as at end of this round."),
    ] = None,
    fmt: Annotated[
        OutputFormat,
        typer.Option("--format", "-f", help="Output format."),
    ] = OutputFormat.table,
    pretty: Annotated[
        bool,
        typer.Option("--pretty", "-p", help="Pretty-print JSON output."),
    ] = False,
) -> None:
    """Show the AFL ladder for a season."""
    _ladder_impl(year, round_number, fmt, pretty)


@app.command(name="get-ladder", hidden=True)
def get_ladder_cmd(
    year: Annotated[
        int,
        typer.Option("--year", help="Season year."),
    ],
    round_number: Annotated[
        int | None,
        typer.Option("--round", help="Ladder as at end of this round."),
    ] = None,
    fmt: Annotated[
        OutputFormat,
        typer.Option("--format", "-f", help="Output format."),
    ] = OutputFormat.table,
    pretty: Annotated[
        bool,
        typer.Option("--pretty", "-p", help="Pretty-print JSON output."),
    ] = False,
) -> None:
    """Show the AFL ladder (alias for ladder)."""
    _ladder_impl(year, round_number, fmt, pretty)


@app.command()
def search(
    query_text: Annotated[
        str,
        typer.Argument(help="Natural language search query."),
    ],
    team: Annotated[
        str | None,
        typer.Option("--team", "-t", help="Filter by team name or alias."),
    ] = None,
    year_from: Annotated[
        int | None,
        typer.Option("--year-from", help="Start year (inclusive)."),
    ] = None,
    year_to: Annotated[
        int | None,
        typer.Option("--year-to", help="End year (inclusive)."),
    ] = None,
    limit: Annotated[
        int,
        typer.Option("--limit", "-n", help="Maximum number of results."),
    ] = 10,
    min_games: Annotated[
        int | None,
        typer.Option("--min-games", help="Minimum games played (player seasons only)."),
    ] = None,
    fmt: Annotated[
        OutputFormat,
        typer.Option("--format", "-f", help="Output format."),
    ] = OutputFormat.table,
    pretty: Annotated[
        bool,
        typer.Option("--pretty", "-p", help="Pretty-print JSON output."),
    ] = False,
) -> None:
    """Search across all AFL data using natural language."""
    from afl_mcp.core.semantic_search import search_afl

    results = search_afl(
        query=query_text,
        limit=limit,
        year_from=year_from,
        year_to=year_to,
        team=team,
        min_games=min_games,
    )

    _output(results, fmt, pretty, title="Search Results")


@app.command()
def status(
    fmt: Annotated[
        OutputFormat,
        typer.Option("--format", "-f", help="Output format."),
    ] = OutputFormat.table,
    pretty: Annotated[
        bool,
        typer.Option("--pretty", "-p", help="Pretty-print JSON output."),
    ] = False,
) -> None:
    """Show data freshness metadata."""
    from afl_mcp.core.queries import get_last_updated

    result = get_last_updated()

    if fmt == OutputFormat.table:
        console.print()
        console.print("[bold]AFL-MCP Data Status[/bold]")
        console.print()
        if result.get("latest_match"):
            m = result["latest_match"]
            console.print(
                f"  Latest match:        {m['date']}  {m['round']}  {m['description']}"
            )
        if result.get("latest_player_stats"):
            s = result["latest_player_stats"]
            console.print(
                f"  Latest player stats: {s['date']}  {s['round']}  {s['description']}"
            )
        if result.get("seasons_available"):
            sa = result["seasons_available"]
            console.print(f"  Seasons:             {sa['from']}-{sa['to']}")
        console.print(f"  Matches:             {result.get('total_matches', '?')}")
        console.print(f"  Players:             {result.get('total_players', '?')}")
        console.print(f"  Stat rows:           {result.get('total_stat_rows', '?')}")
        if result.get("pav_available"):
            pa = result["pav_available"]
            console.print(f"  PAV available:       {pa['from']}-{pa['to']}")
        console.print()
    else:
        _output(result, fmt, pretty)


@app.command()
def serve(
    transport: Annotated[
        Transport,
        typer.Option("--transport", "-T", help="MCP transport protocol."),
    ] = Transport.stdio,
) -> None:
    """Start the MCP server for LLM tool access."""
    from afl_mcp.mcp_server.server import mcp

    console.print(f"[bold]Starting AFL-MCP server[/bold] (transport={transport.value})")
    mcp.run(transport=transport.value)
