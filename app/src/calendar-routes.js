// calendar-routes.js
//
// Serves the Calendar tab -- events are extracted automatically from synced
// email (see email-routes.js's extractCalendarEvents / "/sync"), this router
// just lists/edits/deletes what's already been extracted for the signed-in
// account. See calendar-store.js for the per-account storage.

const express = require("express");
const router = express.Router();

const calendarStore = require("./calendar-store");

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

// Lets the user fix a title/date/time the parser guessed wrong, without
// waiting on a re-sync.
router.put("/events/:id", async (req, res) => {
  const { title, date, hasTime, description } = req.body || {};
  const patch = {};
  if (typeof title === "string") patch.title = title;
  if (typeof date === "string") patch.date = date;
  if (typeof hasTime === "boolean") patch.hasTime = hasTime;
  if (typeof description === "string") patch.description = description;

  const updated = await calendarStore.updateEvent(req.session.userId, req.params.id, patch);
  if (!updated) return res.status(404).json({ error: { message: "No calendar event with that id." } });
  res.json(updated);
});

router.delete("/events/:id", async (req, res) => {
  const ok = await calendarStore.deleteEvent(req.session.userId, req.params.id);
  if (!ok) return res.status(404).json({ error: { message: "No calendar event with that id." } });
  res.json({ ok: true });
});

module.exports = router;
