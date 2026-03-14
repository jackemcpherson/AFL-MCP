"""Semantic search over AFL data using pgvector.

Provides natural language search over player season summaries and
match summaries using cosine similarity on vector embeddings.
"""

from __future__ import annotations

from afl_mcp.core.db import get_pool
from afl_mcp.core.embeddings import embed_text


def semantic_search(
    query: str,
    entity_type: str = "player_season",
    limit: int = 10,
) -> list[dict]:
    """Search for players or matches using natural language.

    Delegates to filtered_semantic_search with no filters applied.

    Args:
        query: Natural language search query.
        entity_type: Either "player_season" or "match".
        limit: Maximum number of results to return.

    Returns:
        List of dicts with similarity score and entity data.
    """
    return filtered_semantic_search(query=query, entity_type=entity_type, limit=limit)


def filtered_semantic_search(
    query: str,
    entity_type: str = "player_season",
    team: str | None = None,
    season_from: int | None = None,
    season_to: int | None = None,
    venue: str | None = None,
    player_name: str | None = None,
    limit: int = 10,
) -> list[dict]:
    """Search with optional SQL filters applied before vector ranking.

    Embeds the query text and runs cosine similarity against either
    player_season_summaries or match_summaries. Optional filters are
    applied as WHERE clauses before the vector ranking.

    Args:
        query: Natural language search query.
        entity_type: Either "player_season" or "match".
        team: Filter by team name (partial, case-insensitive).
        season_from: Minimum season year (inclusive).
        season_to: Maximum season year (inclusive).
        venue: Filter by venue name (partial, case-insensitive).
        player_name: Filter by player surname (partial, case-insensitive).
        limit: Maximum number of results to return.

    Returns:
        List of dicts with similarity score and entity data.
    """
    embedding = embed_text(query)
    pool = get_pool()

    conditions: list[str] = []
    params: list = [embedding]

    if entity_type == "match":
        base_query = """
            SELECT
                ms.summary_text,
                1 - (ms.embedding <=> %s::vector) AS similarity,
                m.round, m.round_number, m.date,
                m.home_points, m.away_points, m.margin,
                ht.name AS home_team, at.name AS away_team,
                v.name AS venue, s.year
            FROM match_summaries ms
            JOIN matches m ON m.id = ms.match_id
            JOIN teams ht ON ht.id = m.home_team_id
            JOIN teams at ON at.id = m.away_team_id
            LEFT JOIN venues v ON v.id = m.venue_id
            JOIN seasons s ON s.id = m.season_id
        """
        if team:
            conditions.append("(ht.name ILIKE %s OR at.name ILIKE %s)")
            params.extend([f"%{team}%", f"%{team}%"])
        if venue:
            conditions.append("v.name ILIKE %s")
            params.append(f"%{venue}%")
        if season_from:
            conditions.append("s.year >= %s")
            params.append(season_from)
        if season_to:
            conditions.append("s.year <= %s")
            params.append(season_to)

        order_col = "ms.embedding"
    else:
        base_query = """
            SELECT
                pss.summary_text,
                1 - (pss.embedding <=> %s::vector) AS similarity,
                p.first_name, p.surname,
                t.name AS team_name,
                s.year
            FROM player_season_summaries pss
            JOIN players p ON p.id = pss.player_id
            JOIN seasons s ON s.id = pss.season_id
            LEFT JOIN LATERAL (
                SELECT DISTINCT ON (pms.player_id) tm.name, tm.id
                FROM player_match_stats pms
                JOIN matches m ON m.id = pms.match_id
                JOIN teams tm ON tm.id = pms.team_id
                WHERE pms.player_id = pss.player_id
                  AND m.season_id = pss.season_id
                ORDER BY pms.player_id, m.date DESC
                LIMIT 1
            ) t ON true
        """
        if team:
            conditions.append("t.name ILIKE %s")
            params.append(f"%{team}%")
        if player_name:
            conditions.append("p.surname ILIKE %s")
            params.append(f"%{player_name}%")
        if season_from:
            conditions.append("s.year >= %s")
            params.append(season_from)
        if season_to:
            conditions.append("s.year <= %s")
            params.append(season_to)

        order_col = "pss.embedding"

    if conditions:
        base_query += " WHERE " + " AND ".join(conditions)

    params.append(embedding)
    params.append(limit)
    base_query += f" ORDER BY {order_col} <=> %s::vector LIMIT %s"

    with pool.connection() as conn:
        rows = conn.execute(base_query, params).fetchall()  # type: ignore[arg-type]

    return rows  # type: ignore[return-value]
