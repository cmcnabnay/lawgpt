-- Splits user_state's single combined `data` JSONB blob into separate
-- columns (matters, saved_reports, custom_notes_prompts, plus the three
-- small scalar fields) -- see src/server.js's GET/POST /api/user/state,
-- which now reads/writes these columns instead of `data`.
--
-- Run this in the Supabase SQL editor (as the project owner/service role --
-- the scoped app_user role this app connects with day-to-day does not own
-- this table and cannot run DDL against it).
--
-- Non-destructive: adds new columns and backfills them from the existing
-- `data` blob for any row that already has one. The old `data` column is
-- deliberately left in place as a rollback/safety net -- drop it yourself
-- once you've confirmed the app is reading/writing the new columns
-- correctly (see the commented DROP at the bottom).

ALTER TABLE user_state
  ADD COLUMN IF NOT EXISTS matters jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS saved_reports jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS custom_notes_prompts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS matter_counter integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS report_counter integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_matter_id text;

UPDATE user_state SET
  matters = COALESCE(data->'matters', '[]'::jsonb),
  saved_reports = COALESCE(data->'savedReports', '[]'::jsonb),
  custom_notes_prompts = COALESCE(data->'customNotesPrompts', '{}'::jsonb),
  matter_counter = COALESCE((data->>'matterCounter')::int, 0),
  report_counter = COALESCE((data->>'reportCounter')::int, 0),
  active_matter_id = data->>'activeMatterId'
WHERE data IS NOT NULL;

-- Once you've confirmed the app is healthy on the new columns:
-- ALTER TABLE user_state DROP COLUMN data;
