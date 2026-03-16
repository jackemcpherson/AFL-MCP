"""Embedding generation using sentence-transformers and pgvector.

Provides text embedding via the all-MiniLM-L6-v2 model and batch
generation of natural language summaries for player seasons and
matches, stored in pgvector-backed tables.
"""

from __future__ import annotations

import logging
from typing import Callable

from afl_mcp.core.db import get_admin_connection

logger = logging.getLogger(__name__)

MODEL_NAME = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384
BATCH_SIZE = 256

_model = None


def _get_model():  # type: ignore[no-untyped-def]
    """Load and cache the sentence-transformer model.

    Lazily imports sentence_transformers to avoid loading PyTorch
    until embeddings are actually needed.

    Returns:
        The cached SentenceTransformer model instance.
    """
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer(MODEL_NAME)
    return _model


def embed_text(text: str) -> list[float]:
    """Embed a single text string.

    Args:
        text: The text to embed.

    Returns:
        A list of floats representing the embedding vector.
    """
    return _get_model().encode(text).tolist()


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed a batch of text strings.

    Args:
        texts: List of texts to embed.

    Returns:
        List of embedding vectors, one per input text.
    """
    embeddings = _get_model().encode(
        texts, batch_size=BATCH_SIZE, show_progress_bar=True
    )
    return [e.tolist() for e in embeddings]


def _build_player_season_summary(row: dict) -> str:
    """Build a natural language summary for a player's season.

    Args:
        row: Dict with keys from the player season aggregation query.

    Returns:
        A human-readable summary string.
    """
    parts = [
        f"{row['first_name']} {row['surname']} ({row['team_name']}, {row['year']}):"
    ]

    parts.append(f"Played {row['matches_played']} matches.")

    averages: list[str] = []
    if row["avg_disposals"]:
        averages.append(f"{row['avg_disposals']:.1f} disposals")
    if row["avg_kicks"]:
        averages.append(f"{row['avg_kicks']:.1f} kicks")
    if row["avg_marks"]:
        averages.append(f"{row['avg_marks']:.1f} marks")
    if row["avg_tackles"]:
        averages.append(f"{row['avg_tackles']:.1f} tackles")
    if averages:
        parts.append(f"Averaged {', '.join(averages)} per game.")
    if row["total_goals"] and row["total_goals"] > 0:
        parts.append(f"Kicked {row['total_goals']} goals for the season.")
    if row["avg_supercoach"]:
        parts.append(f"{row['avg_supercoach']:.1f} SuperCoach average.")
    if row.get("avg_fantasy"):
        parts.append(f"{row['avg_fantasy']:.1f} AFL Fantasy average.")

    return " ".join(parts)


def _build_anon_player_season_summary(row: dict) -> str:
    """Build an anonymized summary for stat-profile similarity.

    Same stats as the named summary but strips player name and team,
    so embeddings cluster by statistical profile rather than identity.
    """
    parts = [f"Season {row['year']}:"]

    parts.append(f"Played {row['matches_played']} matches.")

    averages: list[str] = []
    if row["avg_disposals"]:
        averages.append(f"{row['avg_disposals']:.1f} disposals")
    if row["avg_kicks"]:
        averages.append(f"{row['avg_kicks']:.1f} kicks")
    if row["avg_marks"]:
        averages.append(f"{row['avg_marks']:.1f} marks")
    if row["avg_tackles"]:
        averages.append(f"{row['avg_tackles']:.1f} tackles")
    if averages:
        parts.append(f"Averaged {', '.join(averages)} per game.")
    if row["total_goals"] and row["total_goals"] > 0:
        parts.append(f"Kicked {row['total_goals']} goals for the season.")
    if row["avg_supercoach"]:
        parts.append(f"{row['avg_supercoach']:.1f} SuperCoach average.")
    if row.get("avg_fantasy"):
        parts.append(f"{row['avg_fantasy']:.1f} AFL Fantasy average.")

    return " ".join(parts)


def _build_match_summary(row: dict) -> str:
    """Build a natural language summary for a match.

    Args:
        row: Dict with keys from the match summary query.

    Returns:
        A human-readable summary string.
    """
    result = "def." if row["home_points"] > row["away_points"] else "lost to"
    if row["home_points"] == row["away_points"]:
        result = "drew with"

    return (
        f"Round {row['round_number'] or row['round']}, {row['year']}: "
        f"{row['home_team']} ({row['home_points']}) {result} "
        f"{row['away_team']} ({row['away_points']}) at {row['venue']}. "
        f"Margin: {abs(row['margin'] or 0)} points."
    )


def _embed_and_upsert(
    conn: object,
    rows: list[dict],
    build_summary: Callable[[dict], str],
    upsert_sql: str,
    extract_params: Callable[[dict, str, list[float]], tuple],
    label: str,
) -> int:
    """Build summaries, embed them, and upsert into the database.

    Args:
        conn: Database connection.
        rows: Query result rows to process.
        build_summary: Function to build a summary string from a row.
        upsert_sql: SQL INSERT ... ON CONFLICT statement.
        extract_params: Function taking (row, summary, embedding) and
            returning the parameter tuple for the upsert.
        label: Log label for progress messages.

    Returns:
        Number of rows upserted.
    """
    if not rows:
        return 0

    summaries = [build_summary(row) for row in rows]
    logger.info("Embedding %d %s", len(summaries), label)
    embeddings = embed_batch(summaries)

    params_list = [
        extract_params(row, summary, embedding)
        for summary, row, embedding in zip(summaries, rows, embeddings)
    ]
    cur = conn.cursor()  # type: ignore[union-attr]
    cur.executemany(upsert_sql, params_list)
    conn.commit()  # type: ignore[union-attr]

    return len(rows)


_PLAYER_SEASON_UPSERT = """INSERT INTO player_season_summaries
    (player_id, season_id, summary_text, embedding, anon_embedding)
VALUES (%s, %s, %s, %s, %s)
ON CONFLICT (player_id, season_id) DO UPDATE SET
    summary_text = EXCLUDED.summary_text,
    embedding = EXCLUDED.embedding,
    anon_embedding = EXCLUDED.anon_embedding"""

_MATCH_UPSERT = """INSERT INTO match_summaries
    (match_id, summary_text, embedding)
VALUES (%s, %s, %s)
ON CONFLICT (match_id) DO UPDATE SET
    summary_text = EXCLUDED.summary_text,
    embedding = EXCLUDED.embedding"""

_PLAYER_SEASON_QUERY = """
SELECT
    p.id AS player_id,
    p.first_name,
    p.surname,
    t.name AS team_name,
    s.id AS season_id,
    s.year,
    COUNT(*) AS matches_played,
    AVG(pms.disposals) AS avg_disposals,
    AVG(pms.kicks) AS avg_kicks,
    AVG(pms.marks) AS avg_marks,
    AVG(pms.tackles) AS avg_tackles,
    SUM(pms.goals) AS total_goals,
    AVG(pms.supercoach_score) AS avg_supercoach,
    AVG(pms.afl_fantasy_score) AS avg_fantasy
FROM player_match_stats pms
JOIN players p ON p.id = pms.player_id
JOIN teams t ON t.id = pms.team_id
JOIN matches m ON m.id = pms.match_id
JOIN seasons s ON s.id = m.season_id"""

_MATCH_QUERY = """
SELECT
    m.id AS match_id,
    m.round,
    m.round_number,
    m.home_points,
    m.away_points,
    m.margin,
    ht.name AS home_team,
    at.name AS away_team,
    v.name AS venue,
    s.year
FROM matches m
JOIN teams ht ON ht.id = m.home_team_id
JOIN teams at ON at.id = m.away_team_id
LEFT JOIN venues v ON v.id = m.venue_id
JOIN seasons s ON s.id = m.season_id"""


def _match_params(row: dict, summary: str, embedding: list[float]) -> tuple:
    return (row["match_id"], summary, embedding)


def _embed_player_seasons(conn: object, rows: list[dict], label: str) -> int:
    """Build named + anonymous summaries, embed both, and upsert.

    Player seasons get two embeddings: the named one (for text query
    mode) and an anonymous one (for "find similar" mode).
    """
    if not rows:
        return 0

    named_summaries = [_build_player_season_summary(row) for row in rows]
    anon_summaries = [_build_anon_player_season_summary(row) for row in rows]

    logger.info("Embedding %d %s (named)", len(named_summaries), label)
    named_embeddings = embed_batch(named_summaries)
    logger.info("Embedding %d %s (anonymous)", len(anon_summaries), label)
    anon_embeddings = embed_batch(anon_summaries)

    params_list = [
        (row["player_id"], row["season_id"], summary, named_emb, anon_emb)
        for row, summary, named_emb, anon_emb in zip(
            rows, named_summaries, named_embeddings, anon_embeddings
        )
    ]
    cur = conn.cursor()  # type: ignore[union-attr]
    cur.executemany(_PLAYER_SEASON_UPSERT, params_list)
    conn.commit()  # type: ignore[union-attr]

    return len(rows)


def generate_all_embeddings() -> dict[str, int]:
    """Generate embeddings for player season summaries and match summaries.

    Aggregates player stats by season, generates natural language summaries,
    embeds them in batches, and stores results in pgvector tables. Repeats
    the process for match summaries.

    Returns:
        Dict mapping table name to number of embeddings generated.
    """
    with get_admin_connection() as conn:
        from pgvector.psycopg import register_vector

        register_vector(conn)

        player_seasons = conn.execute(
            _PLAYER_SEASON_QUERY
            + "\nGROUP BY p.id, p.first_name, p.surname, t.name, s.id, s.year"
        ).fetchall()

        match_rows = conn.execute(_MATCH_QUERY).fetchall()

        return {
            "player_season_summaries": _embed_player_seasons(
                conn, player_seasons, "player season summaries"
            ),
            "match_summaries": _embed_and_upsert(
                conn,
                match_rows,
                _build_match_summary,
                _MATCH_UPSERT,
                _match_params,
                "match summaries",
            ),
        }


def generate_incremental_embeddings() -> dict[str, int]:
    """Generate embeddings only for new or updated data.

    Finds player-season combinations and matches that do not yet have
    embeddings (including missing anon_embedding), plus re-embeds all
    current-season player-seasons to keep aggregate stats fresh.

    Returns:
        Dict mapping table name to number of embeddings generated.
    """
    with get_admin_connection() as conn:
        from pgvector.psycopg import register_vector

        register_vector(conn)

        player_seasons = conn.execute(
            _PLAYER_SEASON_QUERY
            + """
LEFT JOIN player_season_summaries pss
    ON pss.player_id = p.id AND pss.season_id = s.id
WHERE pss.id IS NULL
   OR pss.anon_embedding IS NULL
   OR s.year = EXTRACT(YEAR FROM CURRENT_DATE)
GROUP BY p.id, p.first_name, p.surname, t.name, s.id, s.year"""
        ).fetchall()

        match_rows = conn.execute(
            _MATCH_QUERY
            + """
LEFT JOIN match_summaries ms ON ms.match_id = m.id
WHERE ms.id IS NULL"""
        ).fetchall()

        return {
            "player_season_summaries": _embed_player_seasons(
                conn, player_seasons, "player season summaries (incremental)"
            ),
            "match_summaries": _embed_and_upsert(
                conn,
                match_rows,
                _build_match_summary,
                _MATCH_UPSERT,
                _match_params,
                "match summaries (incremental)",
            ),
        }
