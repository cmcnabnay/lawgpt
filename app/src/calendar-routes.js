// calendar-routes.js
//
// Serves the Calendar tab -- events are extracted automatically from synced
// email (see email-routes.js's extractCalendarEvents / "/sync"), this router
// just lists/edits/deletes what's already been extracted for the signed-in
// account. See calendar-store.js for the per-account storage.

const express = require("express");
const router = express.Router();

const calendarStore = require("./calendar-store");
const calendarBackfill = require("./calendar-backfill");

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: { message: "Not signed in." } });
  }
  next();
}
router.use(requireLogin);

router.get("/events", async (req, res) => {
  res.json({ events: await calendarStore.getAll(req.session.userId) });
});

// Lets the user add an event by hand (as opposed to one extracted from a
// synced email) -- e.g. something they heard about in person, or an
// extraction the model missed.
router.post("/events", async (req, res) => {
  const { title, date, time, hasTime, description, location } = req.body || {};
  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: { message: "Title is required." } });
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: { message: "A valid date (YYYY-MM-DD) is required." } });
  }
  const useTime = Boolean(hasTime) && typeof time === "string" && /^\d{1,2}:\d{2}$/.test(time);

  const created = await calendarStore.createEvent(req.session.userId, {
    title: title.trim(),
    date,
    hasTime: useTime,
    time: useTime ? time : null,
    description: typeof description === "string" ? description.trim() : "",
    location: typeof location === "string" ? location.trim() : ""
  });
  res.status(201).json(created);
});

// Lets the user fix a title/date/time/location/description the parser
// guessed wrong (or fill in one it didn't extract), without waiting on a
// re-sync.
router.put("/events/:id", async (req, res) => {
  const { title, date, time, hasTime, description, location } = req.body || {};
  const patch = {};
  if (typeof title === "string") patch.title = title;
  if (typeof date === "string") patch.date = date;
  if (typeof hasTime === "boolean") patch.hasTime = hasTime;
  if (typeof time === "string" || time === null) patch.time = time;
  if (typeof description === "string") patch.description = description;
  if (typeof location === "string") patch.location = location;

  const updated = await calendarStore.updateEvent(req.session.userId, req.params.id, patch);
  if (!updated) return res.status(404).json({ error: { message: "No calendar event with that id." } });
  res.json(updated);
});

router.delete("/events/:id", async (req, res) => {
  const ok = await calendarStore.deleteEvent(req.session.userId, req.params.id);
  if (!ok) return res.status(404).json({ error: { message: "No calendar event with that id." } });
  res.json({ ok: true });
});

// One-time (well, re-runnable) retroactive pass over every already-synced
// email -- see calendar-backfill.js. Fires the job and returns immediately
// with its starting status; the frontend polls GET /backfill/status rather
// than waiting on this request, since a mailbox with a lot of mail can take
// minutes to get through.
router.post("/backfill", async (req, res) => {
  const job = await calendarBackfill.startBackfill(req.session.userId);
  res.json(job);
});

router.get("/backfill/status", (req, res) => {
  res.json(calendarBackfill.getStatus(req.session.userId) || { status: "idle" });
});

// Re-extracts every already-synced email regardless of calendarChecked, and
// wipes existing calendar_events first -- see calendar-backfill.js. Shares
// the same job registry/status polling as /backfill (only one job per
// account at a time either way); the frontend tells them apart via
// job.type.
router.post("/recheck", async (req, res) => {
  const job = await calendarBackfill.startForceRecheck(req.session.userId);
  res.json(job);
});

module.exports = router;
