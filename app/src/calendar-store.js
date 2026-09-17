// calendar-store.js
//
// Per-account store for calendar events extracted from synced email (see
// email-routes.js's extractCalendarEvents, called from /sync). Same
// app_user-backed per-user JSONB pattern already used for agent_runs/
// email_sync_state/doc_overrides -- see agent-store.js, which this mirrors.
//
// Requires (run once against the Supabase app_user DB, alongside whatever
// created users/user_state -- see ~/Documents/setup-user-accounts.sql):
//
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_events JSONB NOT NULL DEFAULT '[]'::jsonb;

const SUPABASE_APP_DB_URL = process.env.SUPABASE_APP_DB_URL || "";
let appPool = null;
if (SUPABASE_APP_DB_URL) {
  const { Pool } = require("pg");
  appPool = new Pool({
    connectionString: SUPABASE_APP_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
}

async function load(userId) {
  if (!appPool || !userId) return [];
  const result = await appPool.query("SELECT calendar_events FROM users WHERE id = $1", [userId]);
  const events = result.rows[0] && result.rows[0].calendar_events;
  return Array.isArray(events) ? events : [];
}

async function save(userId, events) {
  if (!appPool || !userId) return;
  await appPool.query("UPDATE users SET calendar_events = $1 WHERE id = $2", [JSON.stringify(events), userId]);
}

async function getAll(userId) {
  const events = await load(userId);
  return events.slice().sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
}

// Appends events from a freshly-synced message. Called once per /sync with
// every new message's extracted events already batched together, alongside
// emailStore.addMessages -- re-syncing never reprocesses an already-stored
// message (see email-store.js's addMessages dedupe by id), so this never
// needs its own dedupe pass.
async function addEvents(userId, newEvents) {
  if (!newEvents || !newEvents.length) return await load(userId);
  const events = await load(userId);
  events.push(...newEvents);
  await save(userId, events);
  return events;
}

async function updateEvent(userId, id, patch) {
  const events = await load(userId);
  const event = events.find(e => String(e.id) === String(id));
  if (!event) return null;
  Object.assign(event, patch);
  await save(userId, events);
  return event;
}

async function deleteEvent(userId, id) {
  const events = await load(userId);
  const filtered = events.filter(e => String(e.id) !== String(id));
  if (filtered.length === events.length) return false;
  await save(userId, filtered);
  return true;
}

module.exports = { getAll, addEvents, updateEvent, deleteEvent };
