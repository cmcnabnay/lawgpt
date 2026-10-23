// calendar-extract.js
//
// Identifies real calendar-worthy events in a single email's subject/body,
// via a one-shot headless Claude Code CLI call (`claude -p ... --output-format
// json`) rather than a local date-pattern parser. A plain regex/NLP date
// parser (this app's first attempt, chrono-node) can't tell "the review
// session is Friday at 2pm" (a real future event) apart from "thank you for
// attending the review session earlier today" (a past reference that merely
// happens to contain a date-shaped word) -- both look identical to a parser
// that only recognizes date patterns, and in testing that produced false
// events pulled straight from a subject line or greeting. Reading the whole
// email for what's actually being said needs real language understanding --
// that's the whole reason this delegates to Claude Code, per direct
// instruction, instead of trying to special-case the parser further.
//
// Each call is a fresh, independent, non-interactive session (-p, one turn,
// no tools) -- there's no reason for one email's extraction to share a
// Claude Code session with another's. It's still given its own
// --session-id (a fresh UUID we generate, same trick agent-runtime.js uses)
// purely so the exact call behind any one email's extraction can be replayed
// afterward with `claude --resume <that uuid>` -- useful for debugging a
// wrong/missing event, since otherwise a one-shot `-p` call's transcript is
// gone the moment it exits. See agent-runtime.js for the sibling (but
// long-lived, streaming) use of the same CLI for the Agent tab.

const { spawn } = require("child_process");
const crypto = require("crypto");
const { tagLinks, linkForTag } = require("./email-links");

const MAX_EVENTS_PER_MESSAGE = 15; // a weekly digest-style newsletter can legitimately list this many separate real events
const MAX_BODY_CHARS_FOR_EXTRACTION = 8000; // matches MAX_BODY_CHARS in email-routes.js -- the most that's ever actually stored
const EXTRACTION_TIMEOUT_MS = 45000;
// Most CLI calls allowed at once across sync, backfills and RSVP-link
// lookups. Each `claude` process needs ~100MB+, and the production box has
// under 1GB of RAM and 2 CPUs -- uncapped, overlapping jobs pushed it deep
// into swap until every call timed out.
const MAX_CONCURRENT_CLAUDE_CALLS = 2;

// Shared by event extraction and the flag-only pass for existing events
// (extractEventFlagsForMessage below). Digest emails ("This Week at UHLC")
// list many events, each with its own short section -- the flags must come
// from that event's section only, never from a neighboring event's.
const LUNCH_RSVP_RULES = `LUNCH_RSVP_RULES -- decide "lunch" and "rsvp" separately for EACH event, using ONLY the part of the email about that specific event. In a digest/newsletter listing many events, each event has its own block (title, time/room, a category label, a short blurb, maybe a link) -- look only inside that event's block; a different event's food or RSVP link must never carry over.
- "lunch": true if that event's block indicates food will be provided: words like lunch, breakfast, dinner, food, pizza, snacks, refreshments, "grab a bite", "enjoy breakfast", "lunch will be served"; OR the event's title or category label is a food format such as "Lunch & Learn", "Lunch and Learn", "Lunch Social", "Breakfast with ...". Otherwise false.
- "rsvp": true if that event's block asks attendees to RSVP, register, sign up, or buy/get tickets, or has an RSVP/registration/sign-up/tickets link; also true for an entry that is itself an RSVP or registration deadline. Otherwise false.`;

const EXTRACTION_INSTRUCTIONS = `You are reading one email sent to a law student, looking for real calendar-worthy events -- something happening at a specific date/time that belongs on their calendar: a class session, review session, meeting, exam, assignment due date, RSVP deadline, or similar. This may be a single-topic email or a mass weekly digest/newsletter listing many unrelated announcements -- either way, evaluate each potential event independently against every rule below.

Read the whole email for what it actually means, not just which sentences contain a date-shaped word:

- Only extract something that is a FUTURE commitment relative to when this email was sent. An email thanking someone for attending, recapping what already happened, or referencing "earlier today" / "today's session" / "the session we just had" is NOT describing an upcoming event, even though it may mention "today" -- skip it entirely.
- Never invent an event out of the greeting ("Good afternoon,"), sign-off, or the email's own subject line. A title must describe what the event actually is, in your own words if needed -- never just copy the subject line or the first sentence unless that sentence genuinely is the event description.
- Only extract an event if the email states (or clearly implies via a relative phrase like "tomorrow" or "next Friday") an actual date or day for it. Skip vague scheduling talk with no resolvable date ("assignments for next week" with no date attached is not extractable on its own).
- Resolve relative dates ("tomorrow", "next Monday") using the email's own received date as the reference point -- but the event's real date is whatever that resolves to, not the received date itself.
- If a date is followed by a clear label (e.g. "Note: Monday, 10/5: Tentative Midterm date"), that IS a real event -- title it after the label ("Tentative Midterm"), not after surrounding prose.
- If the same real-world event or deadline is mentioned more than once in this email (e.g. summarized in a schedule/table AND again in prose, or repeated for emphasis), output it only ONCE. Never emit two entries for what is really the same event.

Time -- be conservative, this is the part most often gotten wrong:
- Only set "time" when the email states an actual specific clock time in ordinary human-readable form next to that specific event (e.g. "9:00 AM", "2 pm", "noon", "2 - 4 pm" -- use the start time for a range). If you have any doubt about whether a time belongs to this particular event, or the email doesn't give one at all, set "time" to null -- do NOT guess, estimate, default to a round hour, or space events apart by assigning them different times so they don't collide.
- Never take a time from anywhere except plain prose written by the sender: not from the email's own Received/sent timestamp, not from any raw calendar/ICS data (lines like "DTSTART", "TZID", timestamps ending in "Z", or webcal/.ics links), and never convert a stated time to a different timezone -- copy the digits exactly as a human reading this email would understand them.

For each real event found, output an object with:
- "title": short (under 15 words), describing what the event actually is
- "date": the event's date as YYYY-MM-DD
- "time": 24-hour "HH:MM" if a specific time is stated, otherwise null
- "location": the event's location if the email states one -- a room/building, address, or video-call platform ("Zoom", "the class Teams link") -- otherwise null. Never guess a location that isn't actually stated.
- "description": one sentence, quoting or paraphrasing the relevant part of the email
- "lunch": see LUNCH_RSVP_RULES below
- "rsvp": see LUNCH_RSVP_RULES below
- "rsvpLink": links in the email are shown as tags like [L3]. If "rsvp" is true and that event's own block gives an RSVP/registration/sign-up/tickets link, that link's tag (e.g. "L3") -- otherwise null. Same rule as above: never take a link from a different event's block, and never a general website/calendar/newsletter link.

${LUNCH_RSVP_RULES}

Respond with ONLY a JSON array of these objects -- no markdown code fences, no prose before or after. If there are no real calendar-worthy events in this email, respond with exactly: []`;

// Links are swapped for short [L1]-style tags (see email-links.js) before
// the body is capped, so a link-heavy digest still fits whole and Claude can
// name an RSVP link by tag instead of copying it out. Returns the prompt and
// the links in tag order.
function buildPrompt(message) {
  const subject = message.subject || "(no subject)";
  const received = message.date || "unknown";
  const { text, links } = tagLinks(message.body || "");
  const body = text.slice(0, MAX_BODY_CHARS_FOR_EXTRACTION);
  return { prompt: `${EXTRACTION_INSTRUCTIONS}\n\nEMAIL:\nSubject: ${subject}\nReceived: ${received}\nBody:\n${body}`, links };
}

// Spawns `claude -p <prompt> --output-format json --session-id <sessionId>`
// -- a single, tool-free, non-interactive turn, pinned to a caller-supplied
// session id purely so it can be replayed afterward via `claude --resume`.
// Resolves the raw stdout, or null on any failure (missing binary, timeout,
// non-zero exit with no usable output) so the caller can decide how to
// handle "couldn't extract this one" without the whole sync/backfill run
// dying over it.
let activeClaudeCalls = 0;
const waitingClaudeCalls = [];

async function runClaudeExtraction(prompt, sessionId) {
  if (activeClaudeCalls >= MAX_CONCURRENT_CLAUDE_CALLS) {
    await new Promise(resolve => waitingClaudeCalls.push(resolve));
  }
  activeClaudeCalls++;
  try {
    return await spawnClaudeExtraction(prompt, sessionId);
  } finally {
    activeClaudeCalls--;
    const next = waitingClaudeCalls.shift();
    if (next) next();
  }
}

// --tools "" and --strict-mcp-config keep this a plain text turn: no tools,
// and none of the MCP servers configured for interactive/agent sessions
// (e.g. the Playwright browser server), which would otherwise be launched
// for every single extraction call.
function spawnClaudeExtraction(prompt, sessionId) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn("claude", ["-p", prompt, "--output-format", "json", "--session-id", sessionId, "--tools", "", "--strict-mcp-config"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      resolve(null);
      return;
    }

    let stdout = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // SIGKILL, not the default SIGTERM -- a call stuck under memory
      // pressure can ignore SIGTERM and linger, holding its memory.
      try { child.kill("SIGKILL"); } catch (err) { /* already exited */ }
      resolve(null);
    }, EXTRACTION_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

function parseEventsFromClaudeOutput(stdout) {
  if (!stdout) return [];
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (err) {
    return [];
  }
  const text = (envelope && typeof envelope.result === "string") ? envelope.result : "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// Validates a YYYY-MM-DD date and optional HH:MM time and returns them as
// plain strings -- deliberately NOT collapsed into a single Date/ISO
// datetime. Building a Date from these (server-local wall clock) and
// serializing with .toISOString() bakes in the Node process's own timezone;
// the frontend then re-reads that UTC instant in the *browser's* timezone,
// so any server/browser TZ mismatch shifts every event by a constant offset
// (this was the root cause of events all appearing to land around the same
// wrong hour). Keeping date and time as separate, timezone-free strings and
// rendering them verbatim sidesteps the whole conversion.
function toEventDate(dateStr, timeStr) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!dateMatch) return null;
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let time = null, hasTime = false;
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeStr || "");
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      time = String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
      hasTime = true;
    }
  }

  return { date: dateStr, time, hasTime };
}

// Runs extraction for one already-fetched message (shape: { id, subject,
// body, date, courseFolder }) and returns { events, sessionId } --
// sessionId is the Claude Code session this extraction ran in (null if no
// CLI call was actually made, i.e. the empty-message shortcut below), so a
// caller can surface `claude --resume <sessionId>` for replaying/debugging
// that exact extraction. Throws (rather than swallowing) on a failed/timed-
// out CLI call, so callers (email-routes.js's /sync, calendar-backfill.js)
// can tell "genuinely no events" (empty array) apart from "couldn't check
// this one" and leave it eligible for a retry instead of silently marking it
// done.
async function extractCalendarEventsForMessage(message) {
  const subject = message.subject || "";
  const body = message.body || "";
  if (!subject.trim() && !body.trim()) return { events: [], sessionId: null };

  const sessionId = crypto.randomUUID();
  const { prompt, links } = buildPrompt(message);
  const stdout = await runClaudeExtraction(prompt, sessionId);
  if (stdout === null) {
    throw new Error("Claude Code extraction failed or timed out.");
  }

  const raw = parseEventsFromClaudeOutput(stdout).slice(0, MAX_EVENTS_PER_MESSAGE);
  const events = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const resolved = toEventDate(item.date, item.time);
    if (!resolved) continue;

    const title = (typeof item.title === "string" && item.title.trim())
      ? item.title.trim().slice(0, 140)
      : (subject.slice(0, 140) || "(untitled event)");

    events.push({
      id: crypto.randomUUID(),
      title,
      date: resolved.date,
      time: resolved.time,
      hasTime: resolved.hasTime,
      location: (typeof item.location === "string" ? item.location.trim() : "").slice(0, 140),
      description: (typeof item.description === "string" ? item.description : "").slice(0, 300),
      lunch: item.lunch === true,
      rsvp: item.rsvp === true,
      rsvpUrl: item.rsvp === true ? linkForTag(links, item.rsvpLink) : null,
      sourceMessageId: message.id,
      sourceSubject: subject,
      courseFolder: message.courseFolder || "uncategorized",
      createdAt: new Date().toISOString()
    });
  }
  return { events, sessionId };
}

// Fills in lunch/rsvp for events that were already extracted from this
// message (before those fields existed) without re-extracting or touching
// anything else about them. Returns a Map of event id -> { lunch, rsvp };
// throws on a failed/timed-out CLI call.
async function extractEventFlagsForMessage(message, events) {
  const list = events.map((ev, i) => ({
    ref: i + 1,
    title: ev.title,
    date: ev.date,
    time: ev.time || null,
    description: ev.description || ""
  }));
  const body = (message.body || "").slice(0, MAX_BODY_CHARS_FOR_EXTRACTION);
  const prompt = `You are given one email sent to a law student and a list of calendar events that were already extracted from it. For each listed event, decide "lunch" and "rsvp".

${LUNCH_RSVP_RULES}

Respond with ONLY a JSON array with one object per listed event, in the form {"ref": <the event's ref number>, "lunch": true|false, "rsvp": true|false} -- no markdown code fences, no prose before or after.

EVENTS:
${JSON.stringify(list, null, 1)}

EMAIL:
Subject: ${message.subject || "(no subject)"}
Received: ${message.date || "unknown"}
Body:
${body}`;

  const stdout = await runClaudeExtraction(prompt, crypto.randomUUID());
  if (stdout === null) throw new Error("Claude Code flag extraction failed or timed out.");

  const flags = new Map();
  for (const item of parseEventsFromClaudeOutput(stdout)) {
    const ev = item && events[Number(item.ref) - 1];
    if (!ev) continue;
    flags.set(ev.id, { lunch: item.lunch === true, rsvp: item.rsvp === true });
  }
  return flags;
}

// Finds the RSVP links for events already extracted from one email -- for
// events extracted before rsvpUrl existed, especially ones from digest
// emails ("SBA x White & Case", "SBA x Bracewell", ...) where each event has
// its own link and the frontend can't safely guess which is which. One CLI
// call covers every listed event, and Claude answers with link tags (see
// buildPrompt), so only a link actually in the email can come back. Returns
// a Map of event id -> URL or null (null when that event's own section has
// no usable link). Throws on a failed/timed-out CLI call.
async function findRsvpUrlsForMessage(message, events) {
  const { text, links } = tagLinks(message.body || "");
  const body = text.slice(0, MAX_BODY_CHARS_FOR_EXTRACTION);
  const list = events.map((ev, i) => ({
    ref: i + 1,
    title: ev.title,
    date: ev.date,
    time: ev.time || null,
    location: ev.location || "",
    description: ev.description || ""
  }));
  const prompt = `You are given one email sent to a law student and a list of calendar events that were already extracted from it. Links in the email are shown as tags like [L3]. The email may be a digest listing many events, each with its own section and its own links. For EACH listed event, find the RSVP / registration / sign-up / tickets link for that event only, using only that event's own section of the email -- never a link from a different event's section, and never a general website/calendar/newsletter link.

Respond with ONLY a JSON array with one object per listed event, in the form {"ref": <the event's ref number>, "rsvpLink": "<the link's tag, e.g. L3>"} or {"ref": <ref>, "rsvpLink": null} if that event's section has no such link -- no markdown code fences, no prose before or after.

EVENTS:
${JSON.stringify(list, null, 1)}

EMAIL:
Subject: ${message.subject || "(no subject)"}
Body:
${body}`;

  const stdout = await runClaudeExtraction(prompt, crypto.randomUUID());
  if (stdout === null) throw new Error("Claude Code RSVP link lookup failed or timed out.");

  const urls = new Map(events.map(ev => [ev.id, null]));
  for (const item of parseEventsFromClaudeOutput(stdout)) {
    const ev = item && events[Number(item.ref) - 1];
    if (ev) urls.set(ev.id, linkForTag(links, item.rsvpLink));
  }
  return urls;
}

module.exports = { extractCalendarEventsForMessage, extractEventFlagsForMessage, findRsvpUrlsForMessage };
