-- Remove placeholder "teams" and fixture rows the AFL API published for
-- the unresolved 2026 AFLM finals (Wildcard through Grand Final).
-- Source: 2026-07-29 sync:novel-team:AFLM log entry.
--
-- Root cause: the AFL API returns ladder-position and progression labels
-- ("1st".."10th", "Winner of QF1", "Loser of QF2", "Highest-ranked WF
-- Winner", ...) as team names for finals whose participants are not yet
-- known. `ensureTeams` created a team row for each (22 rows) and
-- `upsertMatches` inserted 11 placeholder finals matches referencing them.
--
-- Verified zero player_match_stats / match_lineups / player_season_pav
-- references before deletion. The Worker shipping alongside this migration
-- quarantines placeholder matches at sync time (`isPlaceholderTeamName` /
-- `quarantinePlaceholderMatches`) and self-heals any rows re-inserted by a
-- pre-guard Worker during the deploy window, so these rows cannot be
-- recreated. Real finals matches re-arrive under the same external_afl_id
-- once the AFL resolves the fixture. All DELETEs are idempotent.

-- Child rows first (match_weather / match_predictions reference matches).
DELETE FROM match_weather
WHERE match_id IN (
  SELECT m.id FROM matches m
  JOIN teams ht ON m.home_team_id = ht.id
  JOIN teams at ON m.away_team_id = at.id
  WHERE ht.name IN (
      '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
      'Winner of QF1', 'Winner of QF2', 'Winner of SF1', 'Winner of SF2',
      'Winner of EF1', 'Winner of EF2', 'Winner of PF1', 'Winner of PF2',
      'Loser of QF1', 'Loser of QF2',
      'Highest-ranked WF Winner', 'Lowest-ranked WF Winner'
    )
    OR at.name IN (
      '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
      'Winner of QF1', 'Winner of QF2', 'Winner of SF1', 'Winner of SF2',
      'Winner of EF1', 'Winner of EF2', 'Winner of PF1', 'Winner of PF2',
      'Loser of QF1', 'Loser of QF2',
      'Highest-ranked WF Winner', 'Lowest-ranked WF Winner'
    )
);

DELETE FROM match_predictions
WHERE match_id IN (
  SELECT m.id FROM matches m
  JOIN teams ht ON m.home_team_id = ht.id
  JOIN teams at ON m.away_team_id = at.id
  WHERE ht.name IN (
      '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
      'Winner of QF1', 'Winner of QF2', 'Winner of SF1', 'Winner of SF2',
      'Winner of EF1', 'Winner of EF2', 'Winner of PF1', 'Winner of PF2',
      'Loser of QF1', 'Loser of QF2',
      'Highest-ranked WF Winner', 'Lowest-ranked WF Winner'
    )
    OR at.name IN (
      '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
      'Winner of QF1', 'Winner of QF2', 'Winner of SF1', 'Winner of SF2',
      'Winner of EF1', 'Winner of EF2', 'Winner of PF1', 'Winner of PF2',
      'Loser of QF1', 'Loser of QF2',
      'Highest-ranked WF Winner', 'Lowest-ranked WF Winner'
    )
);

DELETE FROM matches
WHERE home_team_id IN (
    SELECT id FROM teams WHERE name IN (
      '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
      'Winner of QF1', 'Winner of QF2', 'Winner of SF1', 'Winner of SF2',
      'Winner of EF1', 'Winner of EF2', 'Winner of PF1', 'Winner of PF2',
      'Loser of QF1', 'Loser of QF2',
      'Highest-ranked WF Winner', 'Lowest-ranked WF Winner'
    )
  )
  OR away_team_id IN (
    SELECT id FROM teams WHERE name IN (
      '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
      'Winner of QF1', 'Winner of QF2', 'Winner of SF1', 'Winner of SF2',
      'Winner of EF1', 'Winner of EF2', 'Winner of PF1', 'Winner of PF2',
      'Loser of QF1', 'Loser of QF2',
      'Highest-ranked WF Winner', 'Lowest-ranked WF Winner'
    )
  );

DELETE FROM teams
WHERE name IN (
    '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
    'Winner of QF1', 'Winner of QF2', 'Winner of SF1', 'Winner of SF2',
    'Winner of EF1', 'Winner of EF2', 'Winner of PF1', 'Winner of PF2',
    'Loser of QF1', 'Loser of QF2',
    'Highest-ranked WF Winner', 'Lowest-ranked WF Winner'
  );
