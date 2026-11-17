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
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const agentStore = require("./agent-store");
const agentRuntime = require("./agent-runtime");
const documentStore = require("./document-store");
const userDocumentStore = require("./user-document-store");
const { isPdfDocument } = require("./pdf-documents");

const REPO_ROOT = path.join(__dirname, "..", "..");

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: { message: "Not signed in." } });
  }
  next();
}
router.use(requireLogin);

// Same localhost check server.js's requireLocalhost uses for the "reveal in
// file manager" route -- duplicated locally rather than exported from
// server.js to avoid a circular require (server.js is what mounts this
// router). Only ever true when the HTTP request itself originated from this
// same machine, which is the one case where "open a real terminal window"
// (see POST /runs/:id/open-terminal below) can actually work.
function isLocalhostRequest(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function requireLocalhost(req, res, next) {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({
      error: {
        message: "Resuming in a terminal only works when lawgpt is running on your own machine -- this server is remote, so paste the \"claude --resume\" command above into a terminal on the machine that's actually running it instead."
      }
    });
  }
  next();
}

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
    // Answered entirely from memory -- this is polled every 1.5s while the
    // run streams, so it must not touch Supabase.
    return res.json({
      id: req.params.id,
      title: live.title || "Agent run",
      status: live.status,
      output: live.output,
      result: live.result,
      turns: live.turns
    });
  }
  const run = await getOrAdoptRun(userId, req.params.id);
  if (!run) return res.status(404).json({ error: { message: "Run not found." } });
  res.json(run);
});

// Renames a run -- used by the Claude Code session popup's "Open in agent
// tab" so a session opened from a Notes report or an email shows up as
// "<report or email title> - Claude Code" rather than the generic
// "Claude Code session". Goes through getOrAdoptRun so it works on a
// session that isn't a tracked run yet (the popup calls this before its
// first GET).
router.patch("/runs/:id", async (req, res) => {
  const userId = req.session.userId;
  const title = req.body && typeof req.body.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: { message: "title is required." } });
  const run = await getOrAdoptRun(userId, req.params.id);
  if (!run) return res.status(404).json({ error: { message: "Run not found." } });
  // A live run's polls read the title from memory, so rename it there too.
  const live = agentRuntime.getLiveRun(req.params.id);
  if (live && live.userId === userId) live.title = title;
  res.json(await agentStore.updateRun(userId, req.params.id, { title }));
});

async function getOrAdoptRun(userId, id){
  let run = await agentStore.getRun(userId, id);
  if (!run) {
    // Not a run this app ever tracked -- but it might still be a real
    // Claude Code session id that some other part of the app (calendar
    // extraction, a Notes report, ...) spawned with its own --session-id
    // and never registered here (see agent-runtime.js's loadExternalSession
    // for why those still have a real transcript on disk). The "Open in
    // agent tab" button on the Claude session popup (see lawgpt.html's
    // showClaudeSessionPopup) relies on exactly this fallback to make any
    // session id openable, not just ones started from the Agent tab itself.
    // Adopting it into agent-store here (rather than just returning it
    // ad-hoc) means it behaves like any other run from now on -- reopening
    // it is an ordinary getRun, and a follow-up message is an ordinary
    // continueRun.
    const external = await agentRuntime.loadExternalSession(id);
    if (external) {
      await agentStore.createRun(userId, {
        id,
        title: external.title || "Claude Code session",
        prompt: "",
        source: "external",
        output: external.output,
        result: external.result,
        turns: external.turns,
        status: "done",
        cwd: external.cwd || null
      });
      run = await agentStore.getRun(userId, id);
    }
  }
  return run;
}

// True when a document's extracted text is empty apart from pdf-parse's
// "-- 1 of 24 --" page separators -- i.e. a scanned/image-only PDF.
function hasNoRealText(doc) {
  return !String((doc && doc.text) || "").replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").trim();
}

// Adds what the Complete buttons' prompt can't carry on its own. The prompt
// (lawgpt.html's formatAttachedDocumentsForAgent) already inlines every
// attached document's extracted text, so text isn't repeated here. What this
// adds is the actual PDF for the ones where that text can't be trusted:
// - Documents that exist only in this account's user_documents table (e.g.
//   an emailed Lease.pdf) aren't anywhere on disk the agent could open, so
//   their PDFs go in as the actual file (pdfFiles).
// - Scanned PDFs already on disk under documents/<course>/ are named by
//   repo-relative path for the agent to open with Read, which renders the
//   pages as images. They're not inlined: a whole casebook chapter PDF can
//   run past the API's per-request PDF page limit and fail the entire run.
async function resolveAttachedDocuments(userId, documentIds) {
  const scannedOnDisk = [];
  const pdfFiles = [];
  for (const id of Array.isArray(documentIds) ? documentIds : []) {
    const shared = documentStore.getDocument(id);
    if (shared && shared.filePath) {
      const isPdfPath = /\.pdf$/i.test(shared.filePath);
      if (isPdfPath && hasNoRealText(shared)) scannedOnDisk.push(path.join("documents", shared.filePath));
      continue;
    }
    const doc = shared || (await userDocumentStore.getDocument(userId, id));
    if (doc && isPdfDocument(doc)) {
      pdfFiles.push({ name: doc.fileName || doc.title || "document.pdf", buffer: doc.fileBuffer });
    }
  }

  const sections = [];
  if (pdfFiles.length) {
    sections.push("The actual PDF file of each of these attached documents is included with this message: " +
      pdfFiles.map(f => f.name).join(", ") +
      ". Read the PDF itself -- it is the authoritative copy, and any extracted text for it above may be incomplete or empty (scanned pages have no extractable text).");
  }
  if (scannedOnDisk.length) {
    sections.push("These attached documents are scanned PDFs with no extractable text, so the text above for them is empty. Open each one with the Read tool to see its pages:\n" +
      scannedOnDisk.map(p => `- ${p}`).join("\n"));
  }
  return { pdfFiles, note: sections.join("\n\n") };
}

router.post("/run", async (req, res) => {
  const { prompt, title, source, documentIds } = req.body || {};
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: { message: "prompt is required." } });
  }
  const userId = req.session.userId;
  const { pdfFiles, note } = await resolveAttachedDocuments(userId, documentIds);
  const fullPrompt = note ? `${prompt}\n\n---\n\n${note}` : prompt;
  const id = crypto.randomUUID();
  const run = await agentStore.createRun(userId, { id, title, prompt: fullPrompt, source });
  agentRuntime.startRun(userId, id, fullPrompt, REPO_ROOT, run.title, pdfFiles);
  res.json(run);
});

// Sends a follow-up message into an existing run's own Claude Code session
// (see agent-runtime.js's continueRun) -- what backs the chatbox under the
// Agent tab's output panels. Refuses to double-fire while the run is still
// mid-turn: --resume against the same session id from two concurrent
// `claude` invocations would race each other over the same transcript file.
router.post("/runs/:id/message", async (req, res) => {
  const userId = req.session.userId;
  const message = req.body && req.body.message;
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: { message: "message is required." } });
  }
  const run = await agentStore.getRun(userId, req.params.id);
  if (!run) return res.status(404).json({ error: { message: "Run not found." } });
  const live = agentRuntime.getLiveRun(req.params.id);
  if (live && live.status === "running") {
    return res.status(409).json({ error: { message: "This run is still working on the previous message -- wait for it to finish first." } });
  }
  // An adopted external session (see GET /runs/:id above) was spawned from
  // whatever cwd it originally ran in, not necessarily REPO_ROOT -- Claude
  // Code scopes --resume by project directory, so resuming from the wrong
  // one would fail to find it.
  agentRuntime.continueRun(userId, req.params.id, String(message).trim(), run.cwd || REPO_ROOT);
  res.json({ ok: true });
});

function commandExists(cmd){
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch (err) {
    return false;
  }
}

// Builds the tiny script a real terminal window runs to resume this run's
// session interactively. This is the same idea the app used to use for
// EVERY "Send to agent" run before the headless design in agent-runtime.js
// replaced it (see git history: commit 8040c10, "Agent integration into
// ec2") -- that old design spawned a visible terminal unconditionally, which
// silently couldn't work on a headless box like EC2 with no desktop to show
// a window on. Bringing it back only for this opt-in button, gated by
// requireLocalhost below, sidesteps that: it only ever runs when the
// request came from the same machine the server itself is on, which is
// exactly the case where a terminal window can actually appear.
function buildResumeScript(runId, cwd){
  if (process.platform === "win32") {
    const scriptPath = path.join(os.tmpdir(), `lawgpt-agent-resume-${Date.now()}.ps1`);
    const escapedRepo = cwd.replace(/'/g, "''");
    fs.writeFileSync(scriptPath,
      `Set-Location -LiteralPath '${escapedRepo}'\n` +
      `claude --resume ${runId}\n`
    );
    return scriptPath;
  }
  const scriptPath = path.join(os.tmpdir(), `lawgpt-agent-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(scriptPath,
    `#!/bin/sh\n` +
    `cd "${cwd}"\n` +
    `claude --resume ${runId}\n` +
    `echo\n` +
    `echo "[session closed -- press Enter to close this window]"\n` +
    `read _dummy\n`
  );
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}

// Picks the first available terminal emulator for this OS -- same fallback
// chain the old pre-EC2 design used (Tilix first on Linux, since that's what
// a desktop dev box around here actually has installed).
function pickTerminalLauncher(scriptPath, cwd){
  if (process.platform === "darwin") {
    const appleScript = `tell application "Terminal" to do script "${scriptPath.replace(/"/g, '\\"')}"`;
    return { cmd: "osascript", args: ["-e", appleScript] };
  }
  if (process.platform === "win32") {
    if (commandExists("wt")) return { cmd: "wt", args: ["powershell.exe", "-NoExit", "-File", scriptPath] };
    return { cmd: "powershell.exe", args: ["-NoExit", "-File", scriptPath] };
  }
  const linuxCandidates = [
    { cmd: "tilix", args: ["-w", cwd, "-e", scriptPath] },
    { cmd: "gnome-terminal", args: ["--working-directory=" + cwd, "--", scriptPath] },
    { cmd: "konsole", args: ["--workdir", cwd, "-e", scriptPath] },
    { cmd: "xfce4-terminal", args: ["--working-directory=" + cwd, "-e", scriptPath] },
    { cmd: "x-terminal-emulator", args: ["-e", scriptPath] },
    { cmd: "xterm", args: ["-e", scriptPath] }
  ];
  return linuxCandidates.find(c => commandExists(c.cmd)) || null;
}

router.post("/runs/:id/open-terminal", requireLocalhost, async (req, res) => {
  const userId = req.session.userId;
  const run = await agentStore.getRun(userId, req.params.id);
  if (!run) return res.status(404).json({ error: { message: "Run not found." } });

  // An adopted external session (see GET /runs/:id) carries the cwd it was
  // actually spawned from -- resuming from REPO_ROOT would silently fail to
  // find a session that was never created there.
  const cwd = run.cwd || REPO_ROOT;
  const scriptPath = buildResumeScript(run.id, cwd);
  const terminal = pickTerminalLauncher(scriptPath, cwd);
  if (!terminal) {
    return res.status(500).json({
      error: { message: "No terminal emulator found on this system (tried tilix, gnome-terminal, konsole, xfce4-terminal, x-terminal-emulator, xterm)." }
    });
  }
  try {
    const child = spawn(terminal.cmd, terminal.args, { cwd, detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    return res.status(500).json({ error: { message: `Couldn't open a terminal (${terminal.cmd}): ${err.message}` } });
  }
  res.json({ ok: true });
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
