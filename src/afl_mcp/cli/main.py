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
    streamable_http = "streamable-http"


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

    _print_results(
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

        _print_results(
            [{"year": k, "players": v} for k, v in results.items()],
            title="PAV Calculation Summary",
        )


@app.command(name="pav-leaders")
def pav_leaders(
    year: Annotated[int, typer.Argument(help="Season year.")],
    zone: Annotated[
        str | None,
        typer.Option("--zone", "-z", help="Sort by zone: off, mid, or def."),
    ] = None,
    limit: Annotated[
        int,
        typer.Option("--limit", "-n", help="Number of results."),
    ] = 20,
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Show PAV leaderboard for a season."""
    from afl_mcp.core.tools import get_pav_leaders

    try:
        results = get_pav_leaders(year, zone, limit)
    except ValueError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1)

    zone_label = f" ({zone.upper()})" if zone else ""
    if json_output:
        _print_json(results)
    else:
        _print_results(results, title=f"{year} PAV Leaders{zone_label}")


@app.command(name="pav")
def pav_player(
    player: Annotated[str, typer.Argument(help="Player name or ID.")],
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Show a player's PAV history."""
    from afl_mcp.core.tools import get_player_pav

    try:
        player_id = int(player)
        results = get_player_pav(player_id=player_id)
    except ValueError:
        try:
            results = get_player_pav(player_name=player)
        except ValueError as e:
            console.print(f"[red]Error:[/red] {e}")
            raise typer.Exit(code=1)

    if json_output:
        _print_json(results)
    else:
        _print_results(results, title=f"PAV History: {player}")


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
        typer.Option(
            "--season-from",
            "-sf",
            help="Minimum season year.",
            rich_help_panel="Filters",
        ),
    ] = None,
    season_to: Annotated[
        int | None,
        typer.Option(
            "--season-to", "-st", help="Maximum season year.", rich_help_panel="Filters"
        ),
    ] = None,
    venue: Annotated[
        str | None,
        typer.Option(
            "--venue", help="Filter by venue name.", rich_help_panel="Filters"
        ),
    ] = None,
    player: Annotated[
        str | None,
        typer.Option(
            "--player",
            "-p",
            help="Filter by player surname.",
            rich_help_panel="Filters",
        ),
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


# ---------------------------------------------------------------------------
# High-level tool commands
# ---------------------------------------------------------------------------


@app.command()
def players(
    name: Annotated[
        str,
        typer.Argument(help="Player name to search for (partial or full)."),
    ],
    limit: Annotated[
        int,
        typer.Option("--limit", "-n", help="Maximum number of results."),
    ] = 10,
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Search for AFL players by name."""
    from afl_mcp.core.tools import search_players

    results = search_players(name, limit)
    if json_output:
        _print_json(results)
    else:
        _print_results(results, title="Player Search")


@app.command()
def ladder(
    year: Annotated[int, typer.Argument(help="Season year.")],
    round_number: Annotated[
        int | None,
        typer.Option("--round", "-r", help="Ladder as at end of this round."),
    ] = None,
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Show the AFL ladder for a season."""
    from afl_mcp.core.tools import get_ladder

    title = f"{year} Ladder"
    if round_number is not None:
        title += f" (Round {round_number})"
    results = get_ladder(year, round_number)
    if json_output:
        _print_json(results)
    else:
        _print_results(results, title=title)


@app.command()
def leaders(
    stat: Annotated[str, typer.Argument(help="Stat column (e.g. goals, disposals).")],
    season: Annotated[
        int | None,
        typer.Option("--season", "-s", help="Season year (omit for career)."),
    ] = None,
    limit: Annotated[
        int,
        typer.Option("--limit", "-n", help="Number of results."),
    ] = 10,
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Show top players for a statistic."""
    from afl_mcp.core.tools import stat_leaders

    try:
        results = stat_leaders(stat, season, limit)
    except ValueError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1)

    title = f"{'Career' if season is None else season} {stat.replace('_', ' ').title()} Leaders"
    if json_output:
        _print_json(results)
    else:
        _print_results(results, title=title)


@app.command()
def h2h(
    team1: Annotated[str, typer.Argument(help="First team name or alias.")],
    team2: Annotated[str, typer.Argument(help="Second team name or alias.")],
    year_from: Annotated[
        int | None,
        typer.Option("--from", help="Start year (inclusive)."),
    ] = None,
    year_to: Annotated[
        int | None,
        typer.Option("--to", help="End year (inclusive)."),
    ] = None,
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Show head-to-head record between two teams."""
    from afl_mcp.core.tools import head_to_head

    result = head_to_head(team1, team2, year_from, year_to)
    if json_output:
        console.print(JSON(json_lib.dumps(result, indent=2, default=str)))
    else:
        console.print(
            f"\n[bold]{result['team1']}[/bold] vs [bold]{result['team2']}[/bold]"
        )
        console.print(
            f"  {result['team1']}: {result['team1_wins']} wins  |  "
            f"{result['team2']}: {result['team2_wins']} wins  |  "
            f"Draws: {result['draws']}  |  "
            f"Total: {result['total_matches']} matches"
        )
        if result["recent_matches"]:
            _print_results(result["recent_matches"], title="Recent Matches")


@app.command()
def career(
    player: Annotated[str, typer.Argument(help="Player name or ID.")],
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Show a player's career summary."""
    from afl_mcp.core.tools import player_career_summary

    try:
        player_id = int(player)
        result = player_career_summary(player_id=player_id)
    except ValueError:
        try:
            result = player_career_summary(player_name=player)
        except ValueError as e:
            console.print(f"[red]Error:[/red] {e}")
            raise typer.Exit(code=1)

    if json_output:
        console.print(JSON(json_lib.dumps(result, indent=2, default=str)))
    else:
        p = result["player"]
        console.print(f"\n[bold]{p['first_name']} {p['surname']}[/bold]")
        if result["career"]:
            _print_results([result["career"]], title="Career Totals")
        if result["seasons"]:
            _print_results(result["seasons"], title="By Season")


@app.command()
def compare(
    players: Annotated[
        list[str],
        typer.Argument(help="Player IDs or names to compare."),
    ],
    year_from: Annotated[
        int | None,
        typer.Option("--from", help="Start year (inclusive)."),
    ] = None,
    year_to: Annotated[
        int | None,
        typer.Option("--to", help="End year (inclusive)."),
    ] = None,
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Compare stats for multiple players."""
    from afl_mcp.core.tools import player_comparison

    try:
        results = player_comparison(players, year_from, year_to)
    except ValueError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1)
    if json_output:
        _print_json(results)
    else:
        _print_results(results, title="Player Comparison")


@app.command()
def matches(
    team: Annotated[
        str | None,
        typer.Option("--team", "-t", help="Team name or alias."),
    ] = None,
    venue: Annotated[
        str | None,
        typer.Option("--venue", "-v", help="Venue name (partial match)."),
    ] = None,
    year_from: Annotated[
        int | None,
        typer.Option("--from", help="Start year (inclusive)."),
    ] = None,
    year_to: Annotated[
        int | None,
        typer.Option("--to", help="End year (inclusive)."),
    ] = None,
    min_margin: Annotated[
        int | None,
        typer.Option("--min-margin", help="Minimum absolute margin."),
    ] = None,
    max_margin: Annotated[
        int | None,
        typer.Option("--max-margin", help="Maximum absolute margin (for close games)."),
    ] = None,
    limit: Annotated[
        int,
        typer.Option("--limit", "-n", help="Maximum results."),
    ] = 20,
    json_output: Annotated[
        bool,
        typer.Option("--json", "-j", help="Output results as JSON."),
    ] = False,
) -> None:
    """Search for AFL matches by criteria."""
    from afl_mcp.core.tools import search_matches

    results = search_matches(
        team, venue, year_from, year_to, min_margin, max_margin, limit
    )
    if json_output:
        _print_json(results)
    else:
        _print_results(results, title="Match Search")


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
