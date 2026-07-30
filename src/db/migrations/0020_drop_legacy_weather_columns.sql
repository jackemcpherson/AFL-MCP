-- Contract stage for the legacy weather columns: drop
-- matches.weather_temp_c and matches.weather_type.
--
-- The frozen fryzigg record (AFLM 2010-2025, daily-max semantics) was
-- superseded by match_weather in v3.5.0. The v3.7.0 Worker shipping with
-- this migration no longer reads or writes the columns; no index or
-- integrity view references them. If the previous Worker version runs a
-- sync tick between this migration and the Worker upload, that tick's
-- match upsert fails and self-heals on the next tick.

ALTER TABLE matches DROP COLUMN weather_temp_c;
ALTER TABLE matches DROP COLUMN weather_type;
