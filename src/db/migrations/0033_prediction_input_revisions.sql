CREATE TRIGGER public_input_player_match_stats_insert AFTER INSERT ON player_match_stats BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_player_match_stats_update AFTER UPDATE ON player_match_stats
WHEN OLD.match_id IS NOT NEW.match_id OR OLD.player_id IS NOT NEW.player_id OR OLD.team_id IS NOT NEW.team_id OR OLD.guernsey_number IS NOT NEW.guernsey_number OR OLD.player_position IS NOT NEW.player_position OR OLD.subbed IS NOT NEW.subbed OR OLD.time_on_ground_pct IS NOT NEW.time_on_ground_pct OR OLD.kicks IS NOT NEW.kicks OR OLD.handballs IS NOT NEW.handballs OR OLD.disposals IS NOT NEW.disposals OR OLD.effective_disposals IS NOT NEW.effective_disposals OR OLD.disposal_efficiency_pct IS NOT NEW.disposal_efficiency_pct OR OLD.marks IS NOT NEW.marks OR OLD.bounces IS NOT NEW.bounces OR OLD.tackles IS NOT NEW.tackles OR OLD.one_percenters IS NOT NEW.one_percenters OR OLD.clangers IS NOT NEW.clangers OR OLD.contested_possessions IS NOT NEW.contested_possessions OR OLD.uncontested_possessions IS NOT NEW.uncontested_possessions OR OLD.goals IS NOT NEW.goals OR OLD.behinds IS NOT NEW.behinds OR OLD.goal_assists IS NOT NEW.goal_assists OR OLD.shots_at_goal IS NOT NEW.shots_at_goal OR OLD.score_involvements IS NOT NEW.score_involvements OR OLD.score_launches IS NOT NEW.score_launches OR OLD.centre_clearances IS NOT NEW.centre_clearances OR OLD.stoppage_clearances IS NOT NEW.stoppage_clearances OR OLD.clearances IS NOT NEW.clearances OR OLD.contested_marks IS NOT NEW.contested_marks OR OLD.marks_inside_fifty IS NOT NEW.marks_inside_fifty OR OLD.intercept_marks IS NOT NEW.intercept_marks OR OLD.marks_on_lead IS NOT NEW.marks_on_lead OR OLD.free_kicks_for IS NOT NEW.free_kicks_for OR OLD.free_kicks_against IS NOT NEW.free_kicks_against OR OLD.hitouts IS NOT NEW.hitouts OR OLD.hitouts_to_advantage IS NOT NEW.hitouts_to_advantage OR OLD.hitout_win_pct IS NOT NEW.hitout_win_pct OR OLD.ruck_contests IS NOT NEW.ruck_contests OR OLD.inside_fifties IS NOT NEW.inside_fifties OR OLD.rebounds IS NOT NEW.rebounds OR OLD.turnovers IS NOT NEW.turnovers OR OLD.intercepts IS NOT NEW.intercepts OR OLD.metres_gained IS NOT NEW.metres_gained OR OLD.pressure_acts IS NOT NEW.pressure_acts OR OLD.def_half_pressure_acts IS NOT NEW.def_half_pressure_acts OR OLD.tackles_inside_fifty IS NOT NEW.tackles_inside_fifty OR OLD.spoils IS NOT NEW.spoils OR OLD.contest_def_losses IS NOT NEW.contest_def_losses OR OLD.contest_def_one_on_ones IS NOT NEW.contest_def_one_on_ones OR OLD.contest_off_one_on_ones IS NOT NEW.contest_off_one_on_ones OR OLD.contest_off_wins IS NOT NEW.contest_off_wins OR OLD.effective_kicks IS NOT NEW.effective_kicks OR OLD.ground_ball_gets IS NOT NEW.ground_ball_gets OR OLD.f50_ground_ball_gets IS NOT NEW.f50_ground_ball_gets OR OLD.brownlow_votes IS NOT NEW.brownlow_votes OR OLD.rating_points IS NOT NEW.rating_points OR OLD.afl_fantasy_score IS NOT NEW.afl_fantasy_score OR OLD.supercoach_score IS NOT NEW.supercoach_score OR OLD.goal_accuracy IS NOT NEW.goal_accuracy OR OLD.goal_efficiency IS NOT NEW.goal_efficiency OR OLD.shot_efficiency IS NOT NEW.shot_efficiency OR OLD.kick_efficiency IS NOT NEW.kick_efficiency OR OLD.kick_to_handball_ratio IS NOT NEW.kick_to_handball_ratio OR OLD.contested_possession_rate IS NOT NEW.contested_possession_rate OR OLD.contest_def_loss_pct IS NOT NEW.contest_def_loss_pct OR OLD.contest_off_wins_pct IS NOT NEW.contest_off_wins_pct OR OLD.centre_bounce_attendances IS NOT NEW.centre_bounce_attendances OR OLD.kickins IS NOT NEW.kickins OR OLD.kickins_playon IS NOT NEW.kickins_playon OR OLD.interchange_counts IS NOT NEW.interchange_counts OR OLD.total_possessions IS NOT NEW.total_possessions BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_player_match_stats_delete AFTER DELETE ON player_match_stats BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_match_lineups_insert AFTER INSERT ON match_lineups BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_match_lineups_update AFTER UPDATE ON match_lineups
WHEN OLD.match_id IS NOT NEW.match_id OR OLD.player_id IS NOT NEW.player_id OR OLD.team_id IS NOT NEW.team_id OR OLD.guernsey_number IS NOT NEW.guernsey_number OR OLD.position IS NOT NEW.position OR OLD.is_emergency IS NOT NEW.is_emergency OR OLD.is_substitute IS NOT NEW.is_substitute BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_match_lineups_delete AFTER DELETE ON match_lineups BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_player_season_pav_insert AFTER INSERT ON player_season_pav BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_player_season_pav_update AFTER UPDATE ON player_season_pav
WHEN OLD.player_id IS NOT NEW.player_id OR OLD.season_id IS NOT NEW.season_id OR OLD.team_id IS NOT NEW.team_id OR OLD.off_pav IS NOT NEW.off_pav OR OLD.mid_pav IS NOT NEW.mid_pav OR OLD.def_pav IS NOT NEW.def_pav OR OLD.total_pav IS NOT NEW.total_pav BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_player_season_pav_delete AFTER DELETE ON player_season_pav BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_players_insert AFTER INSERT ON players BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_players_update AFTER UPDATE ON players
WHEN OLD.first_name IS NOT NEW.first_name OR OLD.surname IS NOT NEW.surname OR OLD.external_id IS NOT NEW.external_id OR OLD.external_afl_player_id IS NOT NEW.external_afl_player_id OR OLD.date_of_birth IS NOT NEW.date_of_birth OR OLD.height_cm IS NOT NEW.height_cm OR OLD.weight_kg IS NOT NEW.weight_kg OR OLD.is_retired IS NOT NEW.is_retired BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_players_delete AFTER DELETE ON players BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_venues_insert AFTER INSERT ON venues BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_venues_update AFTER UPDATE ON venues
WHEN OLD.name IS NOT NEW.name OR OLD.latitude IS NOT NEW.latitude OR OLD.longitude IS NOT NEW.longitude OR OLD.timezone IS NOT NEW.timezone OR OLD.roof IS NOT NEW.roof OR OLD.canonical_venue_id IS NOT NEW.canonical_venue_id BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_venues_delete AFTER DELETE ON venues BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_match_weather_insert AFTER INSERT ON match_weather BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_match_weather_update AFTER UPDATE ON match_weather
WHEN OLD.match_id IS NOT NEW.match_id OR OLD.kind IS NOT NEW.kind OR OLD.temp_c IS NOT NEW.temp_c OR OLD.precip_mm IS NOT NEW.precip_mm OR OLD.precip_24h_prior_mm IS NOT NEW.precip_24h_prior_mm OR OLD.wind_speed_kmh IS NOT NEW.wind_speed_kmh OR OLD.wind_gust_kmh IS NOT NEW.wind_gust_kmh OR OLD.humidity_pct IS NOT NEW.humidity_pct OR OLD.source IS NOT NEW.source OR OLD.fetched_at IS NOT NEW.fetched_at BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_match_weather_delete AFTER DELETE ON match_weather BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_matches_context_update AFTER UPDATE OF venue_id,kickoff_at ON matches
WHEN OLD.venue_id IS NOT NEW.venue_id OR OLD.kickoff_at IS NOT NEW.kickoff_at
BEGIN
  UPDATE public_input_revision SET revision=revision+1 WHERE id=1;
END;
