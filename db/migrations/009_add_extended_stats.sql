-- Migration 009: Add extended stats columns from AFL API
--
-- Match-level: rushed behinds, minutes in front, quarter-by-quarter scores
-- Player-level: efficiency percentages, kick-ins, interchange counts, etc.

-- Match columns
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_rushed_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_rushed_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_minutes_in_front SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_minutes_in_front SMALLINT;

-- Quarter-by-quarter scores
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_q1_goals SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_q1_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_q2_goals SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_q2_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_q3_goals SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_q3_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_q4_goals SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_q4_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_q1_goals SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_q1_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_q2_goals SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_q2_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_q3_goals SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_q3_behinds SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_q4_goals SMALLINT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_q4_behinds SMALLINT;

-- Player match stat columns
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS goal_accuracy NUMERIC(5,1);
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS goal_efficiency NUMERIC(5,1);
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS shot_efficiency NUMERIC(5,1);
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS kick_efficiency NUMERIC(5,1);
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS kick_to_handball_ratio NUMERIC(5,2);
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS contested_possession_rate NUMERIC(5,1);
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS contest_def_loss_pct NUMERIC(5,1);
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS contest_off_wins_pct NUMERIC(5,1);
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS centre_bounce_attendances SMALLINT;
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS kickins SMALLINT;
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS kickins_playon SMALLINT;
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS interchange_counts SMALLINT;
ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS total_possessions SMALLINT;
