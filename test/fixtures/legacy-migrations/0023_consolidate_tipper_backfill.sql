-- Preserve the completed one-time backfill in the consumer table, then remove staging.
-- Existing predictions and prospective captures always take precedence.
INSERT INTO match_predictions(match_id,home_win_prob,predicted_margin,model_version,generated_at,tipper_run_id)
SELECT r.match_id,r.issued_probability,r.issued_margin,b.model_version,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
FROM tipper_reconstructions r JOIN tipper_reconstruction_batches b ON b.id=r.batch_id
JOIN matches m ON m.id=r.match_id JOIN seasons s ON s.id=m.season_id JOIN competitions c ON c.id=s.competition_id
WHERE b.id=(SELECT id FROM tipper_reconstruction_batches WHERE completed_at IS NOT NULL ORDER BY completed_at DESC,id DESC LIMIT 1) AND b.completed_at IS NOT NULL
AND s.year=2026 AND c.code=r.competition AND m.status='Complete'
AND m.home_team_id=r.home_team_id AND m.away_team_id=r.away_team_id
AND NOT EXISTS(SELECT 1 FROM match_predictions p WHERE p.match_id=r.match_id)
AND NOT EXISTS(SELECT 1 FROM tipper_predictions p WHERE p.match_id=r.match_id)
ON CONFLICT(match_id) DO NOTHING;

DROP TABLE tipper_reconstructions;
DROP TABLE tipper_reconstruction_batches;
