"""Hybrid semantic search over AFL data using pgvector + full-text.

Provides three search tools that combine vector cosine similarity with
PostgreSQL full-text search, fused via Reciprocal Rank Fusion (RRF).
Results are enriched with top performers (matches) and PAV ratings
(player seasons).
"""

from __future__ import annotations

import re

from psycopg.rows import dict_row

from afl_mcp.core.db import get_pool
from afl_mcp.core.tools import _resolve_team_name

RRF_K = 60
POOL_MULTIPLIER = 5

_SYNONYM_MAP: dict[str, str] = {
    "grand final": "GF",
    "preliminary final": "PF",
    "semi final": "SF",
    "semifinal": "SF",
    "elimination final": "EF",
    "qualifying final": "QF",
    "finals": "EF QF SF PF GF",
    "close game": "Margin: 1 Margin: 2 Margin: 3 Margin: 4 Margin: 5",
    "close": "Margin: 1 Margin: 2 Margin: 3",
    "nail-biter": "Margin: 1 Margin: 2 Margin: 3",
    "thriller": "Margin: 1 Margin: 2 Margin: 3",
    "blowout": "Margin: 100 Margin: 120 Margin: 80",
    "demolition": "Margin: 100 Margin: 120",
    "draw": "drew with Margin: 0",
    "drawn": "drew with Margin: 0",
    "ruckman": "hitouts",
    "ruck": "hitouts",
    "forward": "goals kicked",
    "key forward": "goals kicked 40 50 60",
    "midfielder": "disposals clearances tackles",
    "defender": "rebounds intercepts marks",
}


def _expand_query(query: str) -> str:
    """Expand a query with synonym vocabulary for better matching.

    Appends template-vocabulary equivalents so both vector and full-text
    signals can match domain-specific terms.
    """
    lower = query.lower()
    expansions: list[str] = []
    for phrase, expansion in _SYNONYM_MAP.items():
        if phrase in lower:
            expansions.append(expansion)
    if not expansions:
        return query
    return query + " " + " ".join(expansions)


_CLOSE_WORDS = re.compile(r"close|narrow|tight|under", re.IGNORECASE)
_BIG_WORDS = re.compile(r"blowout|demolition|over|big|huge", re.IGNORECASE)

_ROUND_MAP: dict[str, str] = {
    "grand final": "GF",
    "preliminary final": "PF",
    "semi final": "SF",
    "semifinal": "SF",
    "elimination final": "EF",
    "qualifying final": "QF",
}

_PMS_AVG_SUBQUERY = """(
    SELECT AVG(pms_n.{col}) FROM player_match_stats pms_n
    JOIN matches m_n ON m_n.id = pms_n.match_id
    WHERE pms_n.player_id = pss.player_id
      AND m_n.season_id = pss.season_id
) >= %s"""


def _extract_query_filters(query: str, search_type: str) -> tuple[list[str], list]:
    """Extract hard SQL filters from a natural-language query.

    Handles both explicit numeric patterns (e.g. "margin 10",
    "30 disposals") and semantic terms (e.g. "grand final",
    "ruckman", "close game") by converting them to WHERE clauses.
    """
    conditions: list[str] = []
    params: list = []
    lower = query.lower()

    if search_type == "match":
        # Round filters — specific round names
        for phrase, round_val in _ROUND_MAP.items():
            if phrase in lower:
                conditions.append("m.round = %s")
                params.append(round_val)
                break
        else:
            # Generic "finals" → round_type filter
            if "finals" in lower:
                conditions.append("m.round_type = %s")
                params.append("Finals")

        # Margin filters — explicit numeric first
        margin_match = re.search(
            r"(?:margin.*?(\d+)|(\d+)\s*(?:point|pts?).*?margin)",
            query,
            re.IGNORECASE,
        )
        if margin_match:
            value = int(margin_match.group(1) or margin_match.group(2))
            if _CLOSE_WORDS.search(query):
                conditions.append("ABS(m.margin) <= %s")
            elif _BIG_WORDS.search(query):
                conditions.append("ABS(m.margin) >= %s")
            else:
                conditions.append("ABS(m.margin) <= %s")
            params.append(value)
        else:
            # Semantic margin filters (no explicit number)
            if re.search(r"\bdraw\b|\bdrawn\b|\bdrew\b", lower):
                conditions.append("m.margin = 0")
            elif re.search(r"close|nail.?biter|thriller|narrow|tight", lower):
                conditions.append("ABS(m.margin) <= %s")
                params.append(10)
            elif re.search(r"blowout|demolition|thrashing", lower):
                conditions.append("ABS(m.margin) >= %s")
                params.append(60)

    elif search_type == "player_season":
        # Explicit numeric patterns
        disp_match = re.search(r"(\d+)\s*disposals", query, re.IGNORECASE)
        if disp_match:
            value = int(disp_match.group(1))
            conditions.append(_PMS_AVG_SUBQUERY.format(col="disposals"))
            params.append(value - 2)

        goals_match = re.search(r"(\d+)\s*goals", query, re.IGNORECASE)
        if goals_match:
            value = int(goals_match.group(1))
            conditions.append("""(
                SELECT SUM(pms_n.goals) FROM player_match_stats pms_n
                JOIN matches m_n ON m_n.id = pms_n.match_id
                WHERE pms_n.player_id = pss.player_id
                  AND m_n.season_id = pss.season_id
            ) >= %s""")
            params.append(value - 5)

        # Positional filters — only when no explicit stat number given
        if re.search(r"\bruck\b|\bruckman\b", lower) and not disp_match:
            conditions.append(_PMS_AVG_SUBQUERY.format(col="hitouts"))
            params.append(15)

        if "key forward" in lower and not goals_match:
            conditions.append(_PMS_AVG_SUBQUERY.format(col="goals"))
            params.append(1.5)
        elif (
            re.search(r"\bforward\b", lower)
            and "key forward" not in lower
            and not goals_match
        ):
            conditions.append(_PMS_AVG_SUBQUERY.format(col="goals"))
            params.append(1.0)

        if re.search(r"\bmidfielder\b|\bmidfield\b", lower) and not disp_match:
            conditions.append(_PMS_AVG_SUBQUERY.format(col="disposals"))
            params.append(20)

        if re.search(r"\bdefender\b|\bdefensive\b", lower):
            conditions.append(_PMS_AVG_SUBQUERY.format(col="intercepts"))
            params.append(4)

    return conditions, params


def _get_query_vector(query: str) -> list[float]:
    """Embed a text query using the same model as stored embeddings."""
    from afl_mcp.core.embeddings import embed_text

    expanded = _expand_query(query)
    return embed_text(expanded)


def _get_stored_embedding(table: str, where: str, params: list) -> list[float]:
    """Fetch a stored embedding vector from the database.

    Args:
        table: Table name containing the embedding.
        where: WHERE clause to identify the row.
        params: Parameters for the WHERE clause.

    Returns:
        The stored embedding vector.

    Raises:
        ValueError: If the referenced row does not exist.
    """
    pool = get_pool()
    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:  # type: ignore[union-attr]
        row = cur.execute(
            f"SELECT embedding FROM {table} WHERE {where}",  # noqa: S608  # type: ignore[arg-type]
            params,
        ).fetchone()
    if row is None:
        raise ValueError(f"No embedding found in {table} for the given parameters.")
    return row["embedding"]


def _build_match_filters(
    year_from: int | None = None,
    year_to: int | None = None,
    team: str | None = None,
    round_type: str | None = None,
    venue: str | None = None,
    exclude_match_id: int | None = None,
) -> tuple[list[str], list]:
    """Build WHERE conditions for match summary searches."""
    conditions: list[str] = []
    params: list = []

    if year_from is not None:
        conditions.append("s.year >= %s")
        params.append(year_from)
    if year_to is not None:
        conditions.append("s.year <= %s")
        params.append(year_to)
    if team is not None:
        resolved = _resolve_team_name(team)
        conditions.append("(ht.name = %s OR at.name = %s)")
        params.extend([resolved, resolved])
    if round_type is not None:
        conditions.append("m.round_type = %s")
        params.append(round_type)
    if venue is not None:
        conditions.append("v.name ILIKE %s")
        params.append(f"%{venue}%")
    if exclude_match_id is not None:
        conditions.append("ms.match_id != %s")
        params.append(exclude_match_id)

    return conditions, params


def _build_player_season_filters(
    year_from: int | None = None,
    year_to: int | None = None,
    team: str | None = None,
    min_games: int | None = None,
    exclude_player_id: int | None = None,
) -> tuple[list[str], list]:
    """Build WHERE conditions for player season searches."""
    conditions: list[str] = []
    params: list = []

    if year_from is not None:
        conditions.append("s.year >= %s")
        params.append(year_from)
    if year_to is not None:
        conditions.append("s.year <= %s")
        params.append(year_to)
    if team is not None:
        resolved = _resolve_team_name(team)
        conditions.append("""EXISTS (
            SELECT 1 FROM player_match_stats pms2
            JOIN matches m2 ON m2.id = pms2.match_id
            JOIN teams t2 ON t2.id = pms2.team_id
            WHERE pms2.player_id = pss.player_id
              AND m2.season_id = pss.season_id
              AND t2.name = %s
        )""")
        params.append(resolved)
    if min_games is not None:
        conditions.append("""(
            SELECT COUNT(*) FROM player_match_stats pms3
            JOIN matches m3 ON m3.id = pms3.match_id
            WHERE pms3.player_id = pss.player_id
              AND m3.season_id = pss.season_id
        ) >= %s""")
        params.append(min_games)
    if exclude_player_id is not None:
        conditions.append("pss.player_id != %s")
        params.append(exclude_player_id)

    return conditions, params


_MATCH_JOINS = """JOIN matches m ON ms.match_id = m.id
    JOIN seasons s ON m.season_id = s.id
    JOIN teams ht ON ht.id = m.home_team_id
    JOIN teams at ON at.id = m.away_team_id
    LEFT JOIN venues v ON v.id = m.venue_id"""

_PLAYER_SEASON_JOINS = """JOIN seasons s ON pss.season_id = s.id"""


_TABLE_ALIASES: dict[str, str] = {
    "match_summaries": "ms",
    "player_season_summaries": "pss",
}


def _hybrid_search(
    query_vector: list[float],
    query_text: str | None,
    table: str,
    id_column: str,
    join_sql: str,
    filter_conditions: list[str],
    filter_params: list,
    limit: int,
) -> list[dict]:
    """Run hybrid vector + full-text search with RRF fusion.

    Args:
        query_vector: The embedding vector for similarity search.
        query_text: Text for full-text matching (None for pure vector).
        table: Summary table name.
        id_column: Column name for the entity ID.
        join_sql: Additional JOIN clauses for filter support.
        filter_conditions: WHERE clause conditions.
        filter_params: Parameters for the WHERE conditions.
        limit: Maximum results to return.

    Returns:
        List of dicts with entity_id and score, ordered by score DESC.
    """
    pool_size = max(1, min(limit, 50)) * POOL_MULTIPLIER
    if table not in _TABLE_ALIASES:
        raise ValueError(f"Unknown table: {table!r}")
    alias = _TABLE_ALIASES[table]
    where = (" AND " + " AND ".join(filter_conditions)) if filter_conditions else ""

    vector_params: list = [query_vector, *filter_params, query_vector, pool_size]
    vector_cte = f"""vector_ranked AS (
        SELECT {alias}.{id_column},
               ROW_NUMBER() OVER (ORDER BY {alias}.embedding <=> %s::vector) AS rank_v
        FROM {table} {alias}
        {join_sql}
        WHERE true{where}
        ORDER BY {alias}.embedding <=> %s::vector
        LIMIT %s
    )"""

    if query_text is not None:
        text_params: list = [
            query_text,
            query_text,
            *filter_params,
            query_text,
            pool_size,
        ]
        text_cte = f""", text_ranked AS (
        SELECT {alias}.{id_column},
               ROW_NUMBER() OVER (
                   ORDER BY ts_rank(
                       to_tsvector('english', {alias}.summary_text),
                       plainto_tsquery('english', %s)
                   ) DESC
               ) AS rank_t
        FROM {table} {alias}
        {join_sql}
        WHERE to_tsvector('english', {alias}.summary_text)
              @@ plainto_tsquery('english', %s){where}
        ORDER BY ts_rank(
            to_tsvector('english', {alias}.summary_text),
            plainto_tsquery('english', %s)
        ) DESC
        LIMIT %s
    )"""
        fusion_sql = f"""SELECT
            COALESCE(v.{id_column}, t.{id_column}) AS entity_id,
            COALESCE(1.0 / ({RRF_K} + v.rank_v), 0)
                + COALESCE(1.0 / ({RRF_K} + t.rank_t), 0) AS score
        FROM vector_ranked v
        FULL OUTER JOIN text_ranked t ON v.{id_column} = t.{id_column}
        ORDER BY score DESC
        LIMIT %s"""
        all_params = [*vector_params, *text_params, limit]
    else:
        text_cte = ""
        fusion_sql = f"""SELECT
            v.{id_column} AS entity_id,
            1.0 / ({RRF_K} + v.rank_v) AS score
        FROM vector_ranked v
        ORDER BY score DESC
        LIMIT %s"""
        all_params = [*vector_params, limit]

    sql = f"WITH {vector_cte}{text_cte}\n{fusion_sql}"

    pool = get_pool()
    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:  # type: ignore[union-attr]
        if filter_conditions:
            cur.execute("SET LOCAL hnsw.ef_search = 1000")
        return cur.execute(sql, all_params).fetchall()  # type: ignore[return-value]


def _enrich_matches(match_ids: list[int]) -> dict[int, dict]:
    """Fetch full match metadata and top performers for a set of matches.

    Returns a dict keyed by match_id with match details and
    top_performers list (top 3 per team by AFL Fantasy score).
    """
    if not match_ids:
        return {}

    pool = get_pool()
    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:  # type: ignore[union-attr]
        matches = cur.execute(
            """SELECT m.id AS match_id, m.date, m.round, m.round_type,
                      m.home_points, m.away_points, m.margin,
                      m.attendance, m.weather_type, m.weather_temp_c,
                      ht.name AS home_team, at.name AS away_team,
                      v.name AS venue, s.year,
                      ms.summary_text AS summary
               FROM matches m
               JOIN teams ht ON ht.id = m.home_team_id
               JOIN teams at ON at.id = m.away_team_id
               LEFT JOIN venues v ON v.id = m.venue_id
               JOIN seasons s ON s.id = m.season_id
               LEFT JOIN match_summaries ms ON ms.match_id = m.id
               WHERE m.id = ANY(%s)""",
            [match_ids],
        ).fetchall()

        performers = cur.execute(
            """SELECT match_id, player_name, team, disposals, goals,
                      tackles, afl_fantasy_score
               FROM (
                   SELECT pms.match_id,
                          p.first_name || ' ' || p.surname AS player_name,
                          t.name AS team,
                          pms.disposals, pms.goals, pms.tackles,
                          pms.afl_fantasy_score,
                          ROW_NUMBER() OVER (
                              PARTITION BY pms.match_id, pms.team_id
                              ORDER BY COALESCE(
                                  pms.afl_fantasy_score,
                                  COALESCE(pms.disposals, 0) * 2
                                  + COALESCE(pms.goals, 0) * 6
                                  + COALESCE(pms.marks, 0)
                                  + COALESCE(pms.tackles, 0) * 2
                              ) DESC NULLS LAST
                          ) AS rn
                   FROM player_match_stats pms
                   JOIN players p ON pms.player_id = p.id
                   JOIN teams t ON pms.team_id = t.id
                   WHERE pms.match_id = ANY(%s)
               ) ranked
               WHERE rn <= 3
               ORDER BY match_id, team, rn""",
            [match_ids],
        ).fetchall()

    match_map: dict[int, dict] = {}
    for m in matches:
        match_map[m["match_id"]] = {**m, "top_performers": []}

    for perf in performers:
        mid = perf["match_id"]
        if mid in match_map:
            match_map[mid]["top_performers"].append(
                {k: v for k, v in perf.items() if k != "match_id"}
            )

    return match_map


def _enrich_player_seasons(
    entity_ids: list[int],
) -> dict[int, dict]:
    """Fetch player season details and PAV data.

    Args:
        entity_ids: List of player_season_summaries.id values.

    Returns:
        Dict keyed by pss.id with player info, team, year, games, and PAV.
    """
    if not entity_ids:
        return {}

    pool = get_pool()
    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:  # type: ignore[union-attr]
        rows = cur.execute(
            """SELECT pss.id AS pss_id,
                      pss.player_id, pss.season_id,
                      pss.summary_text AS summary,
                      p.first_name, p.surname,
                      s.year,
                      t.name AS team,
                      gc.games,
                      pav.off_pav, pav.mid_pav, pav.def_pav, pav.total_pav
               FROM player_season_summaries pss
               JOIN players p ON p.id = pss.player_id
               JOIN seasons s ON s.id = pss.season_id
               LEFT JOIN LATERAL (
                   SELECT DISTINCT ON (pms2.player_id) tm.name
                   FROM player_match_stats pms2
                   JOIN matches m2 ON m2.id = pms2.match_id
                   JOIN teams tm ON tm.id = pms2.team_id
                   WHERE pms2.player_id = pss.player_id
                     AND m2.season_id = pss.season_id
                   ORDER BY pms2.player_id, m2.date DESC
                   LIMIT 1
               ) t ON true
               LEFT JOIN LATERAL (
                   SELECT COUNT(*)::int AS games
                   FROM player_match_stats pms3
                   JOIN matches m3 ON m3.id = pms3.match_id
                   WHERE pms3.player_id = pss.player_id
                     AND m3.season_id = pss.season_id
               ) gc ON true
               LEFT JOIN player_season_pav pav
                   ON pav.player_id = pss.player_id
                   AND pav.season_id = pss.season_id
               WHERE pss.id = ANY(%s)""",
            [entity_ids],
        ).fetchall()

    result: dict[int, dict] = {}
    for row in rows:
        pss_id = row["pss_id"]
        pav_data = None
        if row["total_pav"] is not None:
            pav_data = {
                "off_pav": row["off_pav"],
                "mid_pav": row["mid_pav"],
                "def_pav": row["def_pav"],
                "total_pav": row["total_pav"],
            }
        result[pss_id] = {
            "player_id": row["player_id"],
            "first_name": row["first_name"],
            "surname": row["surname"],
            "team": row["team"],
            "year": row["year"],
            "games": row["games"],
            "pav": pav_data,
            "summary": row["summary"],
        }

    return result


def search_match_summaries(
    query: str | None = None,
    match_id: int | None = None,
    limit: int = 10,
    year_from: int | None = None,
    year_to: int | None = None,
    team: str | None = None,
    round_type: str | None = None,
    venue: str | None = None,
) -> list[dict]:
    """Search for matches by natural language or similarity to an existing match.

    Uses hybrid search (vector similarity + full-text keyword matching)
    with Reciprocal Rank Fusion. Results include top performers per team.

    Args:
        query: Natural language search query.
        match_id: Find matches similar to this match (uses stored embedding).
        limit: Maximum results (1-50).
        year_from: Filter by start year (inclusive).
        year_to: Filter by end year (inclusive).
        team: Filter by team name or alias.
        round_type: Filter by round type ("Regular" or "Finals").
        venue: Filter by venue name (partial match).

    Returns:
        List of dicts with score, match metadata, and top_performers.

    Raises:
        ValueError: If neither or both of query/match_id provided.
    """
    limit = max(1, min(limit, 50))
    if (query is None) == (match_id is None):
        raise ValueError("Provide exactly one of 'query' or 'match_id'.")

    if query is not None:
        query_vector = _get_query_vector(query)
        query_text: str | None = _expand_query(query)
        exclude_id = None
    else:
        query_vector = _get_stored_embedding(
            "match_summaries", "match_id = %s", [match_id]
        )
        query_text = None
        exclude_id = match_id

    conditions, params = _build_match_filters(
        year_from=year_from,
        year_to=year_to,
        team=team,
        round_type=round_type,
        venue=venue,
        exclude_match_id=exclude_id,
    )

    if query is not None:
        num_conds, num_params = _extract_query_filters(query, "match")
        conditions.extend(num_conds)
        params.extend(num_params)

    ranked = _hybrid_search(
        query_vector=query_vector,
        query_text=query_text,
        table="match_summaries",
        id_column="match_id",
        join_sql=_MATCH_JOINS,
        filter_conditions=conditions,
        filter_params=params,
        limit=limit,
    )

    if not ranked:
        return []

    result_ids = [r["entity_id"] for r in ranked]
    scores = {r["entity_id"]: float(r["score"]) for r in ranked}
    enriched = _enrich_matches(result_ids)

    results = []
    for i, mid in enumerate(result_ids):
        if mid in enriched:
            entry = {"rank": i + 1, "score": round(scores[mid], 6), **enriched[mid]}
            results.append(entry)

    return results


def search_player_seasons(
    query: str | None = None,
    player_id: int | None = None,
    year: int | None = None,
    limit: int = 10,
    year_from: int | None = None,
    year_to: int | None = None,
    team: str | None = None,
    min_games: int | None = None,
) -> list[dict]:
    """Search for player seasons by natural language or similarity.

    Uses hybrid search (vector similarity + full-text keyword matching)
    with Reciprocal Rank Fusion. Results include PAV ratings.

    Args:
        query: Natural language search query.
        player_id: Find seasons similar to this player's season.
        year: Season year for the "find similar" source.
        limit: Maximum results (1-50).
        year_from: Filter by start year (inclusive).
        year_to: Filter by end year (inclusive).
        team: Filter by team name or alias.
        min_games: Minimum games played in the season.

    Returns:
        List of dicts with score, player info, and PAV breakdown.

    Raises:
        ValueError: If input combination is invalid.
    """
    limit = max(1, min(limit, 50))
    has_query = query is not None
    has_similar = player_id is not None or year is not None

    if has_query == has_similar:
        raise ValueError(
            "Provide exactly one of 'query' or both 'player_id' and 'year'."
        )

    if has_similar and (player_id is None or year is None):
        raise ValueError("Both 'player_id' and 'year' are required for similar search.")

    exclude_pid = None

    if query is not None:
        query_vector = _get_query_vector(query)
        query_text: str | None = _expand_query(query)
    else:
        pool = get_pool()
        with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:  # type: ignore[union-attr]
            row = cur.execute(
                """SELECT pss.embedding, pss.player_id
                   FROM player_season_summaries pss
                   JOIN seasons s ON s.id = pss.season_id
                   WHERE pss.player_id = %s AND s.year = %s""",
                [player_id, year],
            ).fetchone()
        if row is None:
            raise ValueError(
                f"No player-season summary found for player_id={player_id}, year={year}."
            )
        query_vector = row["embedding"]
        query_text = None
        exclude_pid = row["player_id"]

    conditions, params = _build_player_season_filters(
        year_from=year_from,
        year_to=year_to,
        team=team,
        min_games=min_games,
        exclude_player_id=exclude_pid,
    )

    if query is not None:
        num_conds, num_params = _extract_query_filters(query, "player_season")
        conditions.extend(num_conds)
        params.extend(num_params)

    ranked = _hybrid_search(
        query_vector=query_vector,
        query_text=query_text,
        table="player_season_summaries",
        id_column="id",
        join_sql=_PLAYER_SEASON_JOINS,
        filter_conditions=conditions,
        filter_params=params,
        limit=limit,
    )

    if not ranked:
        return []

    result_ids = [r["entity_id"] for r in ranked]
    scores = {r["entity_id"]: float(r["score"]) for r in ranked}
    enriched = _enrich_player_seasons(result_ids)

    results = []
    for i, pss_id in enumerate(result_ids):
        if pss_id in enriched:
            entry = {
                "rank": i + 1,
                "score": round(scores[pss_id], 6),
                **enriched[pss_id],
            }
            results.append(entry)

    return results


def search_afl(
    query: str,
    limit: int = 10,
    year_from: int | None = None,
    year_to: int | None = None,
    team: str | None = None,
) -> list[dict]:
    """Unified search across matches and player seasons.

    Runs hybrid search against both tables independently, merges
    results by RRF score, and returns a single ranked list with
    a type discriminator.

    Args:
        query: Natural language search query.
        limit: Maximum total results (1-50).
        year_from: Filter by start year (inclusive).
        year_to: Filter by end year (inclusive).
        team: Filter by team name or alias.

    Returns:
        List of dicts with type ("match" or "player_season"),
        score, and enriched metadata.
    """
    limit = max(1, min(limit, 50))
    query_vector = _get_query_vector(query)
    expanded_text = _expand_query(query)

    match_conditions, match_params = _build_match_filters(
        year_from=year_from, year_to=year_to, team=team
    )
    num_m_conds, num_m_params = _extract_query_filters(query, "match")
    match_conditions.extend(num_m_conds)
    match_params.extend(num_m_params)

    player_conditions, player_params = _build_player_season_filters(
        year_from=year_from, year_to=year_to, team=team
    )
    num_p_conds, num_p_params = _extract_query_filters(query, "player_season")
    player_conditions.extend(num_p_conds)
    player_params.extend(num_p_params)

    match_ranked = _hybrid_search(
        query_vector=query_vector,
        query_text=expanded_text,
        table="match_summaries",
        id_column="match_id",
        join_sql=_MATCH_JOINS,
        filter_conditions=match_conditions,
        filter_params=match_params,
        limit=limit,
    )

    player_ranked = _hybrid_search(
        query_vector=query_vector,
        query_text=expanded_text,
        table="player_season_summaries",
        id_column="id",
        join_sql=_PLAYER_SEASON_JOINS,
        filter_conditions=player_conditions,
        filter_params=player_params,
        limit=limit,
    )

    combined: list[tuple[str, int, float]] = []
    for r in match_ranked:
        combined.append(("match", r["entity_id"], float(r["score"])))
    for r in player_ranked:
        combined.append(("player_season", r["entity_id"], float(r["score"])))

    combined.sort(key=lambda x: x[2], reverse=True)
    combined = combined[:limit]

    match_ids = [eid for typ, eid, _ in combined if typ == "match"]
    player_ids = [eid for typ, eid, _ in combined if typ == "player_season"]

    match_data = _enrich_matches(match_ids)
    player_data = _enrich_player_seasons(player_ids)

    results = []
    for i, (typ, eid, score) in enumerate(combined):
        if typ == "match" and eid in match_data:
            results.append(
                {
                    "rank": i + 1,
                    "type": "match",
                    "score": round(score, 6),
                    **match_data[eid],
                }
            )
        elif typ == "player_season" and eid in player_data:
            results.append(
                {
                    "rank": i + 1,
                    "type": "player_season",
                    "score": round(score, 6),
                    **player_data[eid],
                }
            )

    return results
