"""Embedding generation using sentence-transformers and pgvector.

Provides text embedding via the all-MiniLM-L6-v2 model and batch
generation of natural language summaries for player seasons and
matches, stored in pgvector-backed tables.
"""

from __future__ import annotations

import logging

from afl_mcp.core.db import get_admin_connection

logger = logging.getLogger(__name__)

MODEL_NAME = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384
BATCH_SIZE = 256

_model = None


def _get_model():
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
        f"{row['first_name']} {row['surname']} ({row['team_name']}, {row['year']}): "
    ]

    parts.append(f"Played {row['matches_played']} matches.")

    if row["avg_disposals"]:
        parts.append(f"Averaged {row['avg_disposals']:.1f} disposals")
    if row["avg_kicks"]:
        parts.append(f", {row['avg_kicks']:.1f} kicks")
    if row["avg_marks"]:
        parts.append(f", {row['avg_marks']:.1f} marks")
    if row["avg_tackles"]:
        parts.append(f", {row['avg_tackles']:.1f} tackles per game.")
    if row["total_goals"] and row["total_goals"] > 0:
        parts.append(f" Kicked {row['total_goals']} goals for the season.")
    if row["avg_supercoach"]:
        parts.append(f" {row['avg_supercoach']:.1f} SuperCoach average.")

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


def generate_all_embeddings() -> dict[str, int]:
    """Generate embeddings for player season summaries and match summaries.

    Aggregates player stats by season, generates natural language summaries,
    embeds them in batches, and stores results in pgvector tables. Repeats
    the process for match summaries.

    Returns:
        Dict mapping table name to number of embeddings generated.
    """
    counts: dict[str, int] = {"player_season_summaries": 0, "match_summaries": 0}

    with get_admin_connection() as conn:
        from pgvector.psycopg import register_vector

        register_vector(conn)

        player_seasons = conn.execute("""
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
                AVG(pms.supercoach_score) AS avg_supercoach
            FROM player_match_stats pms
            JOIN players p ON p.id = pms.player_id
            JOIN teams t ON t.id = pms.team_id
            JOIN matches m ON m.id = pms.match_id
            JOIN seasons s ON s.id = m.season_id
            GROUP BY p.id, p.first_name, p.surname, t.name, s.id, s.year
        """).fetchall()

        summaries: list[str] = []
        meta: list[dict] = []
        for row in player_seasons:
            summaries.append(_build_player_season_summary(row))
            meta.append(row)

        if summaries:
            logger.info("Embedding %d player season summaries", len(summaries))
            embeddings = embed_batch(summaries)
            for i, (summary, row) in enumerate(zip(summaries, meta)):
                conn.execute(
                    """INSERT INTO player_season_summaries
                           (player_id, season_id, summary_text, embedding)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (player_id, season_id) DO UPDATE SET
                           summary_text = EXCLUDED.summary_text,
                           embedding = EXCLUDED.embedding""",
                    (row["player_id"], row["season_id"], summary, embeddings[i]),
                )
            conn.commit()
            counts["player_season_summaries"] = len(summaries)

        matches = conn.execute("""
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
            JOIN seasons s ON s.id = m.season_id
        """).fetchall()

        match_summaries: list[str] = []
        match_meta: list[dict] = []
        for row in matches:
            match_summaries.append(_build_match_summary(row))
            match_meta.append(row)

        if match_summaries:
            logger.info("Embedding %d match summaries", len(match_summaries))
            embeddings = embed_batch(match_summaries)
            for i, (summary, row) in enumerate(zip(match_summaries, match_meta)):
                conn.execute(
                    """INSERT INTO match_summaries
                           (match_id, summary_text, embedding)
                       VALUES (%s, %s, %s)
                       ON CONFLICT (match_id) DO UPDATE SET
                           summary_text = EXCLUDED.summary_text,
                           embedding = EXCLUDED.embedding""",
                    (row["match_id"], summary, embeddings[i]),
                )
            conn.commit()
            counts["match_summaries"] = len(match_summaries)

    return counts


def generate_incremental_embeddings() -> dict[str, int]:
    """Generate embeddings only for new or updated data.

    Finds player-season combinations and matches that do not yet have
    embeddings, plus re-embeds all current-season player-seasons to
    keep aggregate stats fresh.

    Returns:
        Dict mapping table name to number of embeddings generated.
    """
    counts: dict[str, int] = {"player_season_summaries": 0, "match_summaries": 0}

    with get_admin_connection() as conn:
        from pgvector.psycopg import register_vector

        register_vector(conn)

        # Player-seasons: new rows OR current season (to refresh aggregates)
        player_seasons = conn.execute("""
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
                AVG(pms.supercoach_score) AS avg_supercoach
            FROM player_match_stats pms
            JOIN players p ON p.id = pms.player_id
            JOIN teams t ON t.id = pms.team_id
            JOIN matches m ON m.id = pms.match_id
            JOIN seasons s ON s.id = m.season_id
            LEFT JOIN player_season_summaries pss
                ON pss.player_id = p.id AND pss.season_id = s.id
            WHERE pss.id IS NULL
               OR s.year = EXTRACT(YEAR FROM CURRENT_DATE)
            GROUP BY p.id, p.first_name, p.surname, t.name, s.id, s.year
        """).fetchall()

        summaries: list[str] = []
        meta: list[dict] = []
        for row in player_seasons:
            summaries.append(_build_player_season_summary(row))
            meta.append(row)

        if summaries:
            logger.info(
                "Embedding %d player season summaries (incremental)",
                len(summaries),
            )
            embeddings = embed_batch(summaries)
            for i, (summary, row) in enumerate(zip(summaries, meta)):
                conn.execute(
                    """INSERT INTO player_season_summaries
                           (player_id, season_id, summary_text, embedding)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (player_id, season_id) DO UPDATE SET
                           summary_text = EXCLUDED.summary_text,
                           embedding = EXCLUDED.embedding""",
                    (row["player_id"], row["season_id"], summary, embeddings[i]),
                )
            conn.commit()
            counts["player_season_summaries"] = len(summaries)

        # Matches: only truly new (results don't change once recorded)
        matches = conn.execute("""
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
            JOIN seasons s ON s.id = m.season_id
            LEFT JOIN match_summaries ms ON ms.match_id = m.id
            WHERE ms.id IS NULL
        """).fetchall()

        match_summaries: list[str] = []
        match_meta: list[dict] = []
        for row in matches:
            match_summaries.append(_build_match_summary(row))
            match_meta.append(row)

        if match_summaries:
            logger.info(
                "Embedding %d match summaries (incremental)",
                len(match_summaries),
            )
            embeddings = embed_batch(match_summaries)
            for i, (summary, row) in enumerate(zip(match_summaries, match_meta)):
                conn.execute(
                    """INSERT INTO match_summaries
                           (match_id, summary_text, embedding)
                       VALUES (%s, %s, %s)
                       ON CONFLICT (match_id) DO UPDATE SET
                           summary_text = EXCLUDED.summary_text,
                           embedding = EXCLUDED.embedding""",
                    (row["match_id"], summary, embeddings[i]),
                )
            conn.commit()
            counts["match_summaries"] = len(match_summaries)

    return counts
