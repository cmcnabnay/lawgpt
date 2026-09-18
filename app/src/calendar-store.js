// calendar-store.js
//
// Per-account store for calendar events extracted from synced email (see
// calendar-extract.js, called from email-routes.js's /sync and from
// calendar-backfill.js). Same app_user-backed per-user JSONB pattern already
// used for agent_runs/email_sync_state/doc_overrides -- see agent-store.js,
// which this mirrors.
//
// Requires (run once against the Supabase app_user DB, alongside whatever
// created users/user_state -- see ~/Documents/setup-user-accounts.sql):
//
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_events JSONB NOT NULL DEFAULT '[]'::jsonb;

const crypto = require("crypto");

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

function sortKeyOf(ev) {
  // ev.date is a plain "YYYY-MM-DD" string (see calendar-extract.js) -- for
  // events stored before that change, ev.date is a full ISO datetime, whose
  // leading "YYYY-MM-DDT..." still sorts correctly alongside the new format.
  return (ev.date || "") + "T" + (ev.time || "00:00");
}

async function getAll(userId) {
  const events = await load(userId);
  return events.slice().sort((a, b) => sortKeyOf(a).localeCompare(sortKeyOf(b)));
}

// Extracts just the YYYY-MM-DD calendar-day prefix, whether ev.date is the
// current plain-date format or an old pre-fix ISO datetime string (both
// start with the date in that form) -- deliberately not routed through
// `new Date(...)`, which would reinterpret a date-only string as UTC
// midnight and can shift it a day in negative-UTC-offset timezones.
function calendarDayKeyOf(dateStr) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(dateStr || "");
  return match ? match[1] : String(dateStr || "");
}

// Strips the kind of prefix/punctuation that makes the same real-world event
// look like two different titles depending on which email mentioned it (a
// syllabus line "9/25: Buyers send redline draft to sellers." vs. a
// follow-up email's prose "Buyer groups send redlines to Seller groups").
function normalizeEventTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/^\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*[:\-]\s*/, "")
    .replace(/[.,;:!?"'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Same calendar day, and either an exact title match or one title contains
// the other once normalized -- a message announcing something and a later
// reminder about the same thing are usually phrased as near-duplicates like
// this rather than word-for-word identical.
function isDuplicateEvent(existing, candidate) {
  if (calendarDayKeyOf(existing.date) !== calendarDayKeyOf(candidate.date)) return false;
  const a = normalizeEventTitle(existing.title);
  const b = normalizeEventTitle(candidate.title);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a));
}

// Appends events from a freshly-synced message (or a backfill batch),
// skipping any candidate that looks like the same real-world event as one
// already stored -- the same deadline can legitimately be mentioned in more
// than one email (an announcement, then a reminder), and each is extracted
// independently with no visibility into the others, so this is the one place
// that actually catches it.
async function addEvents(userId, newEvents) {
  if (!newEvents || !newEvents.length) return await load(userId);
  const events = await load(userId);
  for (const candidate of newEvents) {
    if (!events.some(existing => isDuplicateEvent(existing, candidate))) {
      events.push(candidate);
    }
  }
  await save(userId, events);
  return events;
}

// Manually added by the user from the Calendar tab (as opposed to extracted
// from a synced email) -- no sourceMessageId/sourceSubject, and deliberately
// skips the addEvents() duplicate check above, since a user explicitly
// adding an event should never be silently dropped for looking similar to
// something already on the calendar.
async function createEvent(userId, data) {
  const events = await load(userId);
  const event = {
    id: crypto.randomUUID(),
    title: (data.title || "").trim() || "(untitled event)",
    date: data.date,
    time: data.hasTime ? data.time : null,
    hasTime: Boolean(data.hasTime),
    description: data.description || "",
    location: data.location || "",
    sourceMessageId: null,
    sourceSubject: null,
    courseFolder: "uncategorized",
    createdAt: new Date().toISOString()
  };
  events.push(event);
  await save(userId, events);
  return event;
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

// Wipes every stored event for the account -- used by calendar-backfill.js's
// force-recheck, which regenerates everything from scratch, so stale events
// (including any from before a fix to the extraction/date logic) don't stick
// around alongside the freshly re-extracted ones.
async function clearAll(userId) {
  await save(userId, []);
}

module.exports = { getAll, addEvents, createEvent, updateEvent, deleteEvent, clearAll };
