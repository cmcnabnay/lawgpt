// calendar-backfill.js
//
// One-time (per account), user-triggered pass over every already-synced
// email to extract calendar events retroactively -- for mail that was synced
// before the Calendar tab existed, or before a message got its calendarChecked
// flag set. Ordinary "Sync now" (see email-routes.js's /sync) only ever runs
// extraction on messages it just fetched fresh from Graph, so it never
// reprocesses the whole mailbox; this is the separate, explicit catch-up for
// everything synced before that. Purely local -- it reads from emailStore
// (already-synced messages, no Graph calls) and writes to calendarStore,
// same as /sync does.
//
// Runs as a background job (not awaited by the HTTP request that starts it)
// since a mailbox with a lot of mail means a lot of individual Claude Code
// CLI calls -- each several seconds -- so this could run for minutes. Status
// is polled via getStatus() (see calendar-routes.js). Safe to call again
// later (e.g. after a partial failure, or once more mail has been synced
// since the last backfill) -- it only ever processes messages still missing
// calendarChecked, so nothing gets extracted twice.

const emailStore = require("./email-store");
const calendarStore = require("./calendar-store");
const { extractCalendarEventsForMessage } = require("./calendar-extract");

const CONCURRENCY = 3;

// One job per account at a time -- keyed by userId, not persisted (a server
// restart mid-backfill just means the next click starts a fresh one; nothing
// already marked calendarChecked gets redone).
const jobs = new Map();

function getStatus(userId) {
  return jobs.get(userId) || null;
}

async function startBackfill(userId) {
  const existing = jobs.get(userId);
  if (existing && existing.status === "running") return existing;

  const messages = (await emailStore.getAll(userId)).filter(m => !m.calendarChecked);
  const job = {
    type: "backfill",
    status: "running",
    total: messages.length,
    processed: 0,
    eventsFound: 0,
    failed: 0,
    lastSessionId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null
  };
  jobs.set(userId, job);

  runJob(userId, messages, job).catch(err => {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

// Unlike startBackfill (which only ever looks at messages still missing
// calendarChecked), this re-extracts EVERY already-synced message,
// regardless of that flag, and wipes the account's existing calendar_events
// first. Exists so that events stored before a fix to calendar-extract.js
// (e.g. the server/browser-timezone bug the "date"/"time" fields used to
// have) can be regenerated correctly, rather than being stuck forever since
// their source emails are already calendarChecked. Deliberately not the
// default action (startBackfill) -- it re-runs a Claude Code CLI call per
// email in the whole mailbox, and it throws away every existing calendar
// event (including ones a user manually edited) before it starts.
async function startForceRecheck(userId) {
  const existing = jobs.get(userId);
  if (existing && existing.status === "running") return existing;

  await calendarStore.clearAll(userId);
  const messages = await emailStore.getAll(userId);
  const job = {
    type: "recheck",
    status: "running",
    total: messages.length,
    processed: 0,
    eventsFound: 0,
    failed: 0,
    lastSessionId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null
  };
  jobs.set(userId, job);

  runJob(userId, messages, job).catch(err => {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

async function runJob(userId, messages, job) {
  let index = 0;

  // emailStore.updateMessage/calendarStore.addEvents are each a
  // load-mutate-save round trip against one JSONB column -- fine for a
  // single caller, but concurrent workers finishing at nearly the same time
  // could each load the same "before" state and overwrite each other's write
  // on save. The CLI calls (the actual bottleneck) still run at CONCURRENCY
  // in parallel; only the store writes that follow are funneled through this
  // one-at-a-time queue.
  let writeQueue = Promise.resolve();
  function serializeWrite(fn) {
    const result = writeQueue.then(fn, fn);
    writeQueue = result.catch(() => {});
    return result;
  }

  async function worker() {
    while (index < messages.length) {
      const message = messages[index++];
      try {
        const { events, sessionId } = await extractCalendarEventsForMessage(message);
        if (sessionId) job.lastSessionId = sessionId;
        await serializeWrite(async () => {
          if (events.length) {
            await calendarStore.addEvents(userId, events);
            job.eventsFound += events.length;
          }
          await emailStore.updateMessage(userId, message.id, { calendarChecked: true });
        });
      } catch (err) {
        // Left un-flagged on purpose -- a failed/timed-out extraction stays
        // eligible for the next backfill click rather than being silently
        // skipped forever.
        job.failed++;
      }
      job.processed++;
    }
  }

  const workerCount = Math.max(1, Math.min(CONCURRENCY, messages.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  await writeQueue;

  job.status = "done";
  job.finishedAt = new Date().toISOString();
}

module.exports = { startBackfill, startForceRecheck, getStatus };
