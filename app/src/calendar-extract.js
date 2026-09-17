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

const MAX_EVENTS_PER_MESSAGE = 15; // a weekly digest-style newsletter can legitimately list this many separate real events
const MAX_BODY_CHARS_FOR_EXTRACTION = 8000; // matches MAX_BODY_CHARS in email-routes.js -- the most that's ever actually stored
const EXTRACTION_TIMEOUT_MS = 45000;

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
- "description": one sentence, quoting or paraphrasing the relevant part of the email

Respond with ONLY a JSON array of these objects -- no markdown code fences, no prose before or after. If there are no real calendar-worthy events in this email, respond with exactly: []`;

function buildPrompt(message) {
  const subject = message.subject || "(no subject)";
  const received = message.date || "unknown";
  const body = (message.body || "").slice(0, MAX_BODY_CHARS_FOR_EXTRACTION);
  return `${EXTRACTION_INSTRUCTIONS}\n\nEMAIL:\nSubject: ${subject}\nReceived: ${received}\nBody:\n${body}`;
}

// Spawns `claude -p <prompt> --output-format json --session-id <sessionId>`
// -- a single, tool-free, non-interactive turn, pinned to a caller-supplied
// session id purely so it can be replayed afterward via `claude --resume`.
// Resolves the raw stdout, or null on any failure (missing binary, timeout,
// non-zero exit with no usable output) so the caller can decide how to
// handle "couldn't extract this one" without the whole sync/backfill run
// dying over it.
function runClaudeExtraction(prompt, sessionId) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn("claude", ["-p", prompt, "--output-format", "json", "--session-id", sessionId], {
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
      try { child.kill(); } catch (err) { /* already exited */ }
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
  const stdout = await runClaudeExtraction(buildPrompt(message), sessionId);
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
      description: (typeof item.description === "string" ? item.description : "").slice(0, 300),
      sourceMessageId: message.id,
      sourceSubject: subject,
      courseFolder: message.courseFolder || "uncategorized",
      createdAt: new Date().toISOString()
    });
  }
  return { events, sessionId };
}

module.exports = { extractCalendarEventsForMessage };
