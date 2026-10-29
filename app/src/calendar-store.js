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
async function addEvents(userId, newEvents) {
  if (!newEvents || !newEvents.length) return await load(userId);
  const events = await load(userId);
  for (const candidate of newEvents) {
    const existing = events.find(ev => isDuplicateEvent(ev, candidate));
    if (existing) {
      mergeEventInto(existing, candidate);
    } else {
      candidate.sourceMessageIds = [candidate.sourceMessageId];
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

// Applies the same patch to every event extracted from one email -- used
// when that email gets recategorized, so its events follow it.
async function updateEventsForMessage(userId, messageId, patch) {
  const events = await load(userId);
  let changed = false;
  for (const event of events) {
    if (String(event.sourceMessageId) === String(messageId)) {
      Object.assign(event, patch);
      changed = true;
    }
  }
  if (changed) await save(userId, events);
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

module.exports = { getAll, addEvents, createEvent, updateEvent, updateEventsForMessage, deleteEvent, clearAll };
