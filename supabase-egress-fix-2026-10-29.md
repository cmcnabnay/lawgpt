# Supabase egress problem — 2026-10-29

All paths below are relative to `app/`.

## Summary

The app used 3.1 GB of Supabase egress in 8 days. That is most of the free
plan's 5 GB monthly limit. Egress is the data Supabase sends back out of the
database, so every row the server reads counts against it.

Most of it came from the Agent tab. Every agent run's full transcript lived
in one JSONB array on the user's row, and that whole array was re-read twice
every 1.5 seconds while a run was going. The same pattern, a large array
read or rewritten in full for a small change, also applied to saved Notes,
emails and calendar events.

The fix moved each of these into its own table with one row per item, so
the app reads and writes only what it needs. It was done in four commits on
2026-10-29: `9d289c1`, `ac76ed8`, `e5579d0` and `3dcf043`.

## Where the egress came from

### Primary source: the Agent tab

#### The pieces involved

- `users.agent_runs` (Supabase) was a single JSONB column holding every agent
  run the account had ever made. Each run held its full terminal-style
  transcript (`output`), its final answer (`result`) and its turns (`turns`).
  The column only grew, since old runs were never removed automatically.
- `load()` (src/agent-store.js) read the whole column with
  `SELECT agent_runs FROM users WHERE id = $1`.
- `save()` (src/agent-store.js) wrote the whole column back with
  `UPDATE users SET agent_runs = $1 WHERE id = $2`.
- `getRun()` (src/agent-store.js) returned one run, but did it by calling
  `load()` (src/agent-store.js), reading the whole array, and picking one
  entry out of it.
- `updateRun()` (src/agent-store.js) changed one run, but did it by calling
  `load()` (src/agent-store.js) to read the whole array, changing one entry,
  and calling `save()` (src/agent-store.js) to write the whole array back.
- `liveRuns` (src/agent-runtime.js) is the in-memory copy of each run that is
  still going. It holds the output as Claude Code streams it.
- `scheduleFlush()` (src/agent-runtime.js) saves a running agent's progress
  to the database every 1.5 seconds (`FLUSH_INTERVAL_MS`), so a run survives
  a server restart. Each flush called `updateRun()` (src/agent-store.js).
- The `GET /api/agent/runs/:id` endpoint (src/agent-routes.js) is what the
  Agent tab polls for a run's latest output.
- The poll loops (public/lawgpt.html) call that endpoint every 1.5 seconds
  for as long as a run's status is `running`.

#### What happened during one agent run

1. The user starts a run (see "What started an agent run" below). Claude
   Code starts on the server and its output streams into `liveRuns`
   (src/agent-runtime.js).
2. Every 1.5 seconds, `scheduleFlush()` (src/agent-runtime.js) called
   `updateRun()` (src/agent-store.js). That read the entire
   `users.agent_runs` array (Supabase), with every past run's full
   transcript, changed one entry, and wrote the entire array back.
3. Every 1.5 seconds, the browser polled `GET /api/agent/runs/:id`
   (src/agent-routes.js). The output itself came from `liveRuns`
   (src/agent-runtime.js), but the endpoint still called `getRun()`
   (src/agent-store.js) only to look up the run's title. That read the
   entire array again.
4. So every 1.5 seconds, the database sent out two full copies of every
   transcript the account had ever produced. A run that took a few minutes
   pulled hundreds of copies of all past transcripts. Each new run also made
   the array bigger, so every later run cost more than the one before.

#### What started an agent run

The Agent tab's chat box was not the only way in. Four actions started an
agent run, and all four ended up in `startRun()` or `continueRun()`
(src/agent-runtime.js), which share the same flush code:

- **Agent tab, new chat.** `startAgentChat()` (public/lawgpt.html) calls
  `POST /api/agent/run` (src/agent-routes.js).
- **Agent tab, follow-up message.** `sendAgentFollowup()`
  (public/lawgpt.html) calls `POST /api/agent/runs/:id/message`
  (src/agent-routes.js), which continues the run.
- **The Complete buttons on practice problems and practice quizzes.**
  `completeAssignment()` and `completeQuiz()` (public/lawgpt.html) call
  `generateAgentReport()` (public/lawgpt.html), which calls
  `POST /api/agent/run` (src/agent-routes.js). The result is shown in the
  Notes tab, but it is still an agent run.
- **Email tab, Send to agent.** `sendEmailToAgent()` (public/lawgpt.html)
  calls `POST /api/email/messages/:id/agent/run` (src/email-routes.js),
  which creates the run and calls `startRun()` (src/agent-runtime.js).

Steps 2 and 3 above have different triggers:

- **Step 2 (the server flush) ran for every live run, from any of the four
  actions, whether or not anyone was watching.** It is driven by Claude
  Code's output (`spawnClaude()` calls `scheduleFlush()`, both in
  src/agent-runtime.js), not by the browser.
- **Step 3 (the browser poll) ran only while a page was polling.** That was
  either the Agent tab with a running run open (`openAgentRun()` starts
  `pollAgentRun()`, public/lawgpt.html), or the Complete buttons' own loop
  inside `generateAgentReport()` (public/lawgpt.html). An email run that
  nobody opened in the Agent tab paid for step 2 but not step 3. A running
  run open in two tabs paid for step 3 twice.

**The plain Notes buttons were never part of this.** The per-course Notes
buttons (`generateCivProNotes()`, `generateContractsNotes()`,
`generateTortsNotes()`, `generateTortsCaseNotes()` and `generateLSSNotes()`,
public/lawgpt.html) call `generateReadingReport()` (public/lawgpt.html).
That makes one `POST /api/chat` (src/server.js) request and waits for the
response. `/api/chat` runs a single `claude -p` with its own session id and
never touches `agent-store.js`. It creates no agent run, does no flushing
and does no polling, which is why a Notes report never shows up in the Agent
tab. The only database cost on that path is the one described under Saved
Notes below: saving a report rewrote the whole `user_state` row once, not
every 1.5 seconds.

### Secondary sources

These used the same pattern on a smaller scale.

- **Saved Notes.** All 182 saved reports lived in one
  `user_state.saved_reports` JSONB column (Supabase), about 3.8 MB
  compressed. `GET /api/user/state` (src/server.js) returned the whole
  column on every page load, with every report's full body, even though the
  sidebar only needs titles. `POST /api/user/state` (src/server.js) wrote the
  whole column back on every save.
- **Emails.** 378 synced emails lived in one `users.email_sync_state` JSONB
  column (Supabase). Marking one email done or saving one plan read and
  rewrote every stored email body. The column also held the Outlook sync
  bookmark, which grew the `users` table to 11 MB.
- **Calendar events.** 416 events lived in one `users.calendar_events`
  JSONB array (Supabase). Editing one event read and rewrote all of them,
  and the duplicate-event check read every event to compare against.
- **Sync Now.** Each run rewrote about 290 uncategorized emails even when a
  recheck left them unchanged.

## How it was fixed

### Agent runs (`9d289c1`)

- Moved runs out of `users.agent_runs` (Supabase) into a new `agent_runs`
  table (Supabase) with one row per run.
- `updateRun()` (src/agent-store.js) is now a write-only `UPDATE` of that
  one run's row. The 1.5-second flush from `scheduleFlush()`
  (src/agent-runtime.js) no longer reads anything.
- `getRun()` (src/agent-store.js) reads just the one row it needs.
- `liveRuns` (src/agent-runtime.js) now keeps each run's title in memory, so
  `GET /api/agent/runs/:id` (src/agent-routes.js) answers a poll for a
  running agent entirely from memory and never touches Supabase.
- The run list, `GET /api/agent/runs` (src/agent-routes.js), selects only
  `META_COLUMNS` (src/agent-store.js): id, title, status, source and dates.
  It no longer pulls any transcripts.

As a result, a running agent makes no database reads at all.

### Saved Notes (`ac76ed8`)

- Moved the 182 reports out of `user_state.saved_reports` (Supabase) into a
  new `saved_reports` table (Supabase), one row per report, through
  `saved-report-store.js` (src/saved-report-store.js).
- The page load now gets only the sidebar fields from `listStubs()`
  (src/saved-report-store.js), such as title, course and class label.
- A report's body is fetched from `GET /api/user/reports/:id`
  (src/server.js) only when the report is opened.
- `syncSavedReports()` (public/lawgpt.html) sends only the reports that
  changed to `POST /api/user/reports/sync` (src/server.js).
- This also removed the full overwrite behind the earlier Notes wipe (see
  `notes-data-loss-bug-2026-09-14.md`). A stale or half-loaded tab can no
  longer erase reports it never loaded.

### Emails and calendar events (`e5579d0`, `3dcf043`)

- Moved emails into a new `email_messages` table (Supabase) through
  `email-store.js` (src/email-store.js), one row per email. Marking an email
  done or saving a plan is now a single-row update.
- Sync Now (src/email-routes.js) reads only the stored email ids to decide
  what is new.
- Moved events into a new `calendar_events` table (Supabase) through
  `calendar-store.js` (src/calendar-store.js), one row per event.
- Added a generated `event_day` column, so the duplicate-event check reads
  only that day's events.
- Added a generated `source_message_id` column, so a recategorized email
  moves only its own events.
- Renamed `users.email_sync_state` to `users.email_delta_link` (Supabase)
  and narrowed it to a single text column holding only the Outlook sync
  bookmark. This shrank the `users` table from 11 MB to 160 kB.
- Sync Now (src/email-routes.js) skips the update when a recheck leaves an
  email's course and fields as they were, so it stops rewriting the roughly
  290 unchanged emails on every run.

### Checks done during the migration

- Row counts in each new table were matched against the old arrays before
  the old columns were dropped.
- Row-level security stays on for each new table, with a policy for the
  app's own database role (`app_user`). The public read-only SQL editor
  still cannot read private rows.

## Where the fix lives

- `src/agent-store.js`, `src/agent-runtime.js`, `src/agent-routes.js`: the
  `agent_runs` table, write-only flushes, and polls answered from memory.
- `src/saved-report-store.js`, `src/server.js`, `public/lawgpt.html`: the
  `saved_reports` table, stub loading, open-on-demand bodies, and changed-only
  sync.
- `src/email-store.js`, `src/calendar-store.js`, `src/email-routes.js`: the
  `email_messages` and `calendar_events` tables, the generated columns, and
  the Sync Now changes.
- Each store file's header comment has the `CREATE TABLE` statement for its
  table.
