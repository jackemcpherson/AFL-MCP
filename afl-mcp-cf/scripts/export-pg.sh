#!/usr/bin/env bash
set -euo pipefail

# Export AFL-MCP PostgreSQL data to CSV for D1 migration
# Usage: DATABASE_URL=postgres://... ./scripts/export-pg.sh

EXPORT_DIR="$(dirname "$0")/../data/export"
mkdir -p "$EXPORT_DIR"

echo "Exporting to $EXPORT_DIR..."

psql "$DATABASE_URL" -c "\copy (SELECT id, code, name FROM competitions ORDER BY id) TO '$EXPORT_DIR/competitions.csv' WITH CSV HEADER"
echo "  competitions"

psql "$DATABASE_URL" -c "\copy (SELECT id, competition_id, year FROM seasons ORDER BY id) TO '$EXPORT_DIR/seasons.csv' WITH CSV HEADER"
echo "  seasons"

psql "$DATABASE_URL" -c "\copy (SELECT id, name, abbreviation, competition_id FROM teams ORDER BY id) TO '$EXPORT_DIR/teams.csv' WITH CSV HEADER"
echo "  teams"

psql "$DATABASE_URL" -c "\copy (SELECT id, name FROM venues ORDER BY id) TO '$EXPORT_DIR/venues.csv' WITH CSV HEADER"
echo "  venues"

# Excludes embedding/vector columns
psql "$DATABASE_URL" -c "\copy (SELECT id, first_name, surname, external_id, external_afl_player_id, date_of_birth, height_cm, weight_kg, is_retired FROM players ORDER BY id) TO '$EXPORT_DIR/players.csv' WITH CSV HEADER"
echo "  players"

psql "$DATABASE_URL" -c "\copy (SELECT id, season_id, round, round_number, round_type, date, local_time, venue_id, home_team_id, away_team_id, home_goals, home_behinds, home_points, away_goals, away_behinds, away_points, margin, attendance, weather_temp_c, weather_type, external_afltables_id, external_fryzigg_id, external_afl_id, home_rushed_behinds, away_rushed_behinds, home_minutes_in_front, away_minutes_in_front, home_q1_goals, home_q1_behinds, home_q2_goals, home_q2_behinds, home_q3_goals, home_q3_behinds, home_q4_goals, home_q4_behinds, away_q1_goals, away_q1_behinds, away_q2_goals, away_q2_behinds, away_q3_goals, away_q3_behinds, away_q4_goals, away_q4_behinds FROM matches ORDER BY id) TO '$EXPORT_DIR/matches.csv' WITH CSV HEADER"
echo "  matches"

psql "$DATABASE_URL" -c "\copy (SELECT id, match_id, player_id, team_id, guernsey_number, player_position, subbed, time_on_ground_pct, kicks, handballs, disposals, effective_disposals, disposal_efficiency_pct, marks, bounces, tackles, one_percenters, clangers, contested_possessions, uncontested_possessions, goals, behinds, goal_assists, shots_at_goal, score_involvements, score_launches, centre_clearances, stoppage_clearances, clearances, contested_marks, marks_inside_fifty, intercept_marks, marks_on_lead, free_kicks_for, free_kicks_against, hitouts, hitouts_to_advantage, hitout_win_pct, ruck_contests, inside_fifties, rebounds, turnovers, intercepts, metres_gained, pressure_acts, def_half_pressure_acts, tackles_inside_fifty, spoils, contest_def_losses, contest_def_one_on_ones, contest_off_one_on_ones, contest_off_wins, effective_kicks, ground_ball_gets, f50_ground_ball_gets, brownlow_votes, rating_points, afl_fantasy_score, supercoach_score, goal_accuracy, goal_efficiency, shot_efficiency, kick_efficiency, kick_to_handball_ratio, contested_possession_rate, contest_def_loss_pct, contest_off_wins_pct, centre_bounce_attendances, kickins, kickins_playon, interchange_counts, total_possessions FROM player_match_stats ORDER BY id) TO '$EXPORT_DIR/player_match_stats.csv' WITH CSV HEADER"
echo "  player_match_stats"

psql "$DATABASE_URL" -c "\copy (SELECT id, player_id, season_id, team_id, off_pav, mid_pav, def_pav, total_pav FROM player_season_pav ORDER BY id) TO '$EXPORT_DIR/player_season_pav.csv' WITH CSV HEADER"
echo "  player_season_pav"

echo ""
echo "Export complete. Files in $EXPORT_DIR:"
ls -lh "$EXPORT_DIR"
echo ""
echo "Total size:"
du -sh "$EXPORT_DIR"
