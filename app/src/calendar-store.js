// calendar-store.js
//
// Per-account store for calendar events extracted from synced email (see
// calendar-extract.js, called from email-routes.js's /sync and from
// calendar-backfill.js), plus ones added by hand -- one row per event in
// the `calendar_events` table (`data` holds the whole event object), rather
// than the single users.calendar_events array they used to live in, where
// editing one event read and rewrote all of them. `event_day` and
// `source_message_id` are generated from `data` so addEvents' duplicate
// check can read just that day's events and a recategorized email can move
// just its own events.
//
// Requires (run once against the Supabase app_user DB):
//
//   CREATE TABLE IF NOT EXISTS calendar_events (
//     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//     id TEXT NOT NULL,
//     data JSONB NOT NULL,
//     event_day TEXT GENERATED ALWAYS AS (substring(data->>'date' from '^\d{4}-\d{2}-\d{2}')) STORED,
//     source_message_id TEXT GENERATED ALWAYS AS (data->>'sourceMessageId') STORED,
//     PRIMARY KEY (user_id, id)
//   );
//   CREATE INDEX IF NOT EXISTS calendar_events_user_day_idx ON calendar_events(user_id, event_day);
//   CREATE INDEX IF NOT EXISTS calendar_events_user_source_idx ON calendar_events(user_id, source_message_id);
//   GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_events TO app_user;
//   CREATE POLICY app_user_full_access ON calendar_events
//     FOR ALL TO app_user USING (true) WITH CHECK (true);

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
  const result = await appPool.query("SELECT data FROM calendar_events WHERE user_id = $1", [userId]);
  return result.rows.map(r => r.data);
}

// Inserts or replaces whole events, by id.
async function upsertEvents(userId, events) {
  if (!appPool || !userId) return;
  for (const event of events) {
    await appPool.query(
      `INSERT INTO calendar_events (user_id, id, data) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, id) DO UPDATE SET data = EXCLUDED.data`,
      [userId, String(event.id), JSON.stringify(event)]
    );
  }
}

// One event, scoped to the owning user.
async function getEvent(userId, id) {
  if (!appPool || !userId || id == null) return null;
  const result = await appPool.query(
    "SELECT data FROM calendar_events WHERE user_id = $1 AND id = $2",
    [userId, String(id)]
  );
  return result.rows[0] ? result.rows[0].data : null;
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

// Stripped out before comparing titles word-by-word (see titleWordOverlap)
// so the comparison is driven by the words that actually distinguish one
// event from another, not ones every announcement shares regardless of
// topic.
const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "with",
  "from", "by", "is", "are", "this", "that", "today"
]);

// Trailing-"s" plural stripped off words long enough that it's unlikely to
// mangle anything else ("buyers"/"buyer", "sellers"/"seller") -- the same
// event mentioned in an announcement vs. a follow-up email often flips
// singular/plural phrasing ("Buyer sends..." vs. "Buyer groups send...").
function stem(word) {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function significantWords(title) {
  return normalizeEventTitle(title)
    .split(/[^a-z0-9]+/)
    .filter(w => w && !TITLE_STOPWORDS.has(w))
    .map(stem);
}

// Catches the same real-world event announced twice under titles too
// differently worded/ordered for the substring check below to catch --
// e.g. "Candidate Seminar for SBA Class Rep Elections" vs. "SBA Class Rep
// candidate seminar (mandatory)", where neither title contains the other
// but most of each one's meaningful words appear in the other. Requires
// both a minimum absolute overlap (3+ shared words) and a minimum overlap
// ratio (half of the shorter title's words) -- either alone is too easy for
// two short, topically-similar-but-different titles to satisfy by chance.
function titleWordOverlap(a, b) {
  const wordsA = new Set(significantWords(a));
  const wordsB = new Set(significantWords(b));
  if (wordsA.size < 2 || wordsB.size < 2) return { shared: 0, ratio: 0 };
  let shared = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) shared++; });
  return { shared, ratio: shared / Math.min(wordsA.size, wordsB.size) };
}

// Same calendar day, and one of: an exact title match, one title contains
// the other once normalized, or enough of their significant words overlap
// -- a message announcing something and a later reminder about the same
// thing are usually phrased as near-duplicates like this rather than
// word-for-word identical.
function isDuplicateEvent(existing, candidate) {
  if (calendarDayKeyOf(existing.date) !== calendarDayKeyOf(candidate.date)) return false;
  const a = normalizeEventTitle(existing.title);
  const b = normalizeEventTitle(candidate.title);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a))) return true;
  const overlap = titleWordOverlap(existing.title, candidate.title);
  return overlap.shared >= 3 && overlap.ratio >= 0.5;
}

// Fields a later email can fill in when the first email to mention an event
// left them blank -- e.g. a digest sent the week before that didn't have a
// room yet, followed by one that did.
const MERGEABLE_FIELDS = ["location", "rsvpUrl", "description"];

// Copies onto `existing` whatever `candidate` knows that it doesn't, and
// records the candidate's email as another source. Only fills gaps -- never
// overwrites a value already stored, since backfill can process an older
// email after a newer one and a user may have edited the event by hand.
function mergeEventInto(existing, candidate) {
  for (const field of MERGEABLE_FIELDS) {
    if (!existing[field] && candidate[field]) existing[field] = candidate[field];
  }
  if (!existing.hasTime && candidate.hasTime) {
    existing.time = candidate.time;
    existing.hasTime = true;
  }
  if (candidate.lunch) existing.lunch = true;
  if (candidate.rsvp) existing.rsvp = true;

  const sources = existing.sourceMessageIds || (existing.sourceMessageId ? [existing.sourceMessageId] : []);
  if (candidate.sourceMessageId && !sources.some(id => String(id) === String(candidate.sourceMessageId))) {
    sources.push(candidate.sourceMessageId);
  }
  existing.sourceMessageIds = sources;
}

// Appends events from a freshly-synced message (or a backfill batch). A
// candidate that looks like the same real-world event as one already stored
// is merged into it rather than dropped, so a later email can supply
// details (room, time, RSVP link) the first one didn't have.
// Only events on the candidates' own days are read -- isDuplicateEvent
// never matches across days -- and only the merged or new ones are
// written. Returns those touched events.
async function addEvents(userId, newEvents) {
  if (!newEvents || !newEvents.length || !appPool || !userId) return [];
  const days = [...new Set(newEvents.map(ev => calendarDayKeyOf(ev.date)))];
  const result = await appPool.query(
    "SELECT data FROM calendar_events WHERE user_id = $1 AND event_day = ANY($2::text[])",
    [userId, days]
  );
  const events = result.rows.map(r => r.data);
  const touched = new Map();
  for (const candidate of newEvents) {
    const existing = events.find(ev => isDuplicateEvent(ev, candidate));
    if (existing) {
      mergeEventInto(existing, candidate);
      touched.set(existing.id, existing);
    } else {
      candidate.sourceMessageIds = [candidate.sourceMessageId];
      events.push(candidate);
      touched.set(candidate.id, candidate);
    }
  }
  await upsertEvents(userId, [...touched.values()]);
  return [...touched.values()];
}

// Manually added by the user from the Calendar tab (as opposed to extracted
// from a synced email) -- no sourceMessageId/sourceSubject, and deliberately
// skips the addEvents() duplicate check above, since a user explicitly
// adding an event should never be silently dropped for looking similar to
// something already on the calendar.
async function createEvent(userId, data) {
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
  await upsertEvents(userId, [event]);
  return event;
}

// Merges `patch` onto one event's row without reading it first; returns
// the updated event, or null if there's no such id.
async function updateEvent(userId, id, patch) {
  if (!appPool || !userId) return null;
  const result = await appPool.query(
    "UPDATE calendar_events SET data = data || $3::jsonb WHERE user_id = $1 AND id = $2 RETURNING data",
    [userId, String(id), JSON.stringify(patch || {})]
  );
  return result.rows[0] ? result.rows[0].data : null;
}

// Applies the same patch to every event extracted from one email -- used
// when that email gets recategorized, so its events follow it.
async function updateEventsForMessage(userId, messageId, patch) {
  if (!appPool || !userId || messageId == null) return;
  await appPool.query(
    "UPDATE calendar_events SET data = data || $3::jsonb WHERE user_id = $1 AND source_message_id = $2",
    [userId, String(messageId), JSON.stringify(patch || {})]
  );
}

async function deleteEvent(userId, id) {
  if (!appPool || !userId) return false;
  const result = await appPool.query(
    "DELETE FROM calendar_events WHERE user_id = $1 AND id = $2",
    [userId, String(id)]
  );
  return result.rowCount > 0;
}

// Wipes every stored event for the account -- used by calendar-backfill.js's
// force-recheck, which regenerates everything from scratch, so stale events
// (including any from before a fix to the extraction/date logic) don't stick
// around alongside the freshly re-extracted ones.
async function clearAll(userId) {
  if (!appPool || !userId) return;
  await appPool.query("DELETE FROM calendar_events WHERE user_id = $1", [userId]);
}

module.exports = { getAll, getEvent, addEvents, createEvent, updateEvent, updateEventsForMessage, deleteEvent, clearAll };
