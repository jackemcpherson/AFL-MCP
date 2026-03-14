"""AFL-MCP command-line interface.

Provides commands for querying the AFL database, running semantic
search, managing database migrations and data loading, inspecting
the schema, and starting the MCP server.
"""

from __future__ import annotations

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


class EntityType(str, Enum):
    """Search entity type options."""

    player_season = "player_season"
    match = "match"


class Transport(str, Enum):
    """MCP transport protocol options."""

    stdio = "stdio"
    sse = "sse"


def _is_numeric(value: object) -> bool:
    """Check whether a value looks numeric for table column alignment.

    Args:
        value: Any value from a query result row.

    Returns:
        True if the value can be interpreted as a number.
    """
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


def _print_results(rows: list[dict], title: str | None = None) -> None:
    """Render a list of dicts as a Rich table.

    Automatically right-aligns columns detected as numeric based on
    the first row, and uses alternating row styles for readability.

    Args:
        rows: List of result dicts to render.
        title: Optional table title.
    """
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


def _print_json(rows: list[dict]) -> None:
    """Print results as syntax-highlighted JSON.

    Args:
        rows: List of result dicts to render.
    """
    console.print(JSON(json_lib.dumps(rows, indent=2, default=str)))


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

    _print_results(
        [{"table": k, "rows": v} for k, v in counts.items()],
        title="Load Summary",
    )


@db_app.command()
def embed() -> None:
    """Generate vector embeddings for semantic search."""
    from afl_mcp.core.embeddings import generate_all_embeddings

    with console.status("[bold]Generating embeddings...", spinner="dots"):
        counts = generate_all_embeddings()

    _print_results(
        [{"table": k, "count": v} for k, v in counts.items()],
        title="Embedding Summary",
    )


@app.command()
def query(
    sql: Annotated[
        str,
        typer.Argument(help="SQL SELECT query to execute."),
    ],
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Execute a read-only SQL query against the AFL database."""
    from afl_mcp.core.queries import execute_query

    try:
        results = execute_query(sql)
    except ValueError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1)

    if json_output:
        _print_json(results)
    else:
        _print_results(results)


@app.command()
def search(
    query_text: Annotated[
        str,
        typer.Argument(help="Natural language search query."),
    ],
    entity_type: Annotated[
        EntityType,
        typer.Option("--type", "-t", help="Entity type to search."),
    ] = EntityType.player_season,
    team: Annotated[
        str | None,
        typer.Option("--team", help="Filter by team name.", rich_help_panel="Filters"),
    ] = None,
    season_from: Annotated[
        int | None,
        typer.Option("--season-from", "-sf", help="Minimum season year.", rich_help_panel="Filters"),
    ] = None,
    season_to: Annotated[
        int | None,
        typer.Option("--season-to", "-st", help="Maximum season year.", rich_help_panel="Filters"),
    ] = None,
    venue: Annotated[
        str | None,
        typer.Option("--venue", help="Filter by venue name.", rich_help_panel="Filters"),
    ] = None,
    player: Annotated[
        str | None,
        typer.Option("--player", "-p", help="Filter by player surname.", rich_help_panel="Filters"),
    ] = None,
    limit: Annotated[
        int,
        typer.Option("--limit", "-n", help="Maximum number of results."),
    ] = 10,
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Search for AFL players or matches using natural language."""
    from afl_mcp.core.search import filtered_semantic_search

    results = filtered_semantic_search(
        query=query_text,
        entity_type=entity_type.value,
        team=team,
        season_from=season_from,
        season_to=season_to,
        venue=venue,
        player_name=player,
        limit=limit,
    )

    if json_output:
        _print_json(results)
    else:
        _print_results(results)


@app.command()
def schema(
    table_name: Annotated[
        str | None,
        typer.Argument(help="Table name to inspect. Omit for all tables."),
    ] = None,
) -> None:
    """Show database schema -- tables, columns, types, and foreign keys."""
    from afl_mcp.core.queries import get_schema_info, get_foreign_keys

    columns = get_schema_info(table_name)
    title = f"Schema: {table_name}" if table_name else "Database Schema"
    _print_results(columns, title=title)

    if not table_name:
        fks = get_foreign_keys()
        if fks:
            _print_results(fks, title="Foreign Keys")


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
