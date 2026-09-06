// agent-routes.js
//
// Backs the Agent tab: lists an account's past "Send to agent" runs and
// fetches one run's live/stored output for the polling "terminal" view (see
// lawgpt.html's renderAgentSidebar/pollAgentRun). GET /runs/:id prefers
// agent-runtime's in-memory copy while a run is still active (cheaper and
// more current than round-tripping through Supabase every poll) and falls
// back to the persisted copy in agent-store.js once it's finished or after a
// server restart.
//
// Runs themselves are actually started from wherever the prompt comes from
// -- currently only email-routes.js's "Send to agent" button, which already
// has its own auth-checked message lookup to do first and calls
// agent-store.js/agent-runtime.js directly. This router's own POST /run
// exists so the Agent tab (or anything else later) can start a run without
// going through the email flow.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const path = require("path");
const agentStore = require("./agent-store");
const agentRuntime = require("./agent-runtime");

const REPO_ROOT = path.join(__dirname, "..", "..");

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: { message: "Not signed in." } });
  }
  next();
}
router.use(requireLogin);

// List view only -- omits `output` and `prompt`, which can be large, since
// the sidebar just needs id/title/status/timestamps to render.
router.get("/runs", async (req, res) => {
  const runs = await agentStore.getAll(req.session.userId);
  res.json({
    runs: runs.map(r => ({ id: r.id, title: r.title, status: r.status, source: r.source, createdAt: r.createdAt, updatedAt: r.updatedAt }))
  });
});

router.get("/runs/:id", async (req, res) => {
  const userId = req.session.userId;
  const live = agentRuntime.getLiveRun(req.params.id);
  if (live && live.userId === userId) {
    const stored = await agentStore.getRun(userId, req.params.id);
    return res.json({
      id: req.params.id,
      title: (stored && stored.title) || "Agent run",
      status: live.status,
      output: live.output,
      result: live.result
    });
  }
  const run = await agentStore.getRun(userId, req.params.id);
  if (!run) return res.status(404).json({ error: { message: "Run not found." } });
  res.json(run);
});

router.post("/run", async (req, res) => {
  const { prompt, title, source } = req.body || {};
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: { message: "prompt is required." } });
  }
  const id = crypto.randomUUID();
  const run = await agentStore.createRun(req.session.userId, { id, title, prompt, source });
  agentRuntime.startRun(req.session.userId, id, prompt, REPO_ROOT);
  res.json(run);
});

router.delete("/runs/:id", async (req, res) => {
  // No-op if this run already finished (killRun just clears the in-memory
  // entry if present) -- stops the underlying process rather than leaving
  // it running with nowhere for its output to go once the record is gone.
  agentRuntime.killRun(req.params.id);
  const deleted = await agentStore.deleteRun(req.session.userId, req.params.id);
  if (!deleted) return res.status(404).json({ error: { message: "Run not found." } });
  res.json({ ok: true });
});

module.exports = router;
