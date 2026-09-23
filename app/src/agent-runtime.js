// agent-runtime.js
//
// Runs the Claude Code CLI headlessly for the Agent tab's "Send to agent"
// feature -- a plain background child process, no GUI terminal, so it works
// the same whether the server is on a desktop machine or a headless box like
// EC2 (see email-routes.js's comment history for why the old
// open-a-visible-terminal design couldn't work there at all).
//
// Uses --output-format stream-json (newline-delimited JSON, one event per
// line) instead of plain text so the Agent tab's "terminal" panel can show
// what an interactive session actually looks like -- the assistant's
// running commentary, which tools it invokes and with what input, and each
// tool's result -- rather than just the CLI's final answer, which is all
// plain -p text output would give us. The final "result" event's text is
// kept separately (entry.result) since that's the actual deliverable the
// Agent tab's compiled-markdown Output panel renders, distinct from the
// terminal-style transcript.
//
// Both are buffered in-memory per run while it's in flight (liveRuns) so the
// Agent tab can poll cheaply without hitting Supabase on every chunk, then
// flushed to agent-store.js on a short debounce while running and always
// once more on completion -- so a run survives a server restart and shows
// up again next time the account signs in, same as email/notes state.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const agentStore = require("./agent-store");

const liveRuns = new Map(); // runId -> { userId, output, result, turns, status, child }
const flushTimers = new Map();
const FLUSH_INTERVAL_MS = 1500;
const MAX_TOOL_RESULT_CHARS = 4000;

function scheduleFlush(userId, runId){
  if (flushTimers.has(runId)) return;
  flushTimers.set(runId, setTimeout(async () => {
    flushTimers.delete(runId);
    const entry = liveRuns.get(runId);
    if (!entry) return;
    await agentStore.updateRun(userId, runId, { output: entry.output, result: entry.result, turns: entry.turns, status: entry.status });
  }, FLUSH_INTERVAL_MS));
}

// Best-effort summary of a tool call's input for the terminal transcript --
// Bash's "command" and Write/Edit/Read's "file_path" are what's actually
// worth showing at a glance; anything else falls back to compact JSON,
// capped so one odd tool call with a huge input can't flood the log.
function formatToolInput(input){
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return " " + input.command;
  if (typeof input.file_path === "string") return " " + input.file_path;
  try {
    const json = JSON.stringify(input);
    return json.length > 200 ? " " + json.slice(0, 200) + "…" : " " + json;
  } catch (err) {
    return "";
  }
}

function toolResultText(content){
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
  }
  return "";
}

function indentBlock(text){
  const truncated = text.length > MAX_TOOL_RESULT_CHARS
    ? text.slice(0, MAX_TOOL_RESULT_CHARS) + "\n…[truncated]"
    : text;
  return truncated.split("\n").map(line => "  " + line).join("\n");
}

// Turns one parsed stream-json event into terminal-transcript text appended
// to entry.output, and captures the final deliverable into entry.result --
// see the module comment above for why those are tracked separately. Silent
// no-op for event types with nothing worth showing (e.g. the initial
// "system"/"init" event).
function handleStreamEvent(entry, evt){
  if (!evt || typeof evt !== "object") return;

  if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (!block) continue;
      if (block.type === "text" && block.text) {
        entry.output += block.text;
      } else if (block.type === "tool_use") {
        entry.output += `\n\n$ ${block.name || "tool"}${formatToolInput(block.input)}\n`;
      }
    }
  } else if (evt.type === "user" && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (block && block.type === "tool_result") {
        const text = toolResultText(block.content);
        if (text) entry.output += indentBlock(text) + "\n";
      }
    }
  } else if (evt.type === "result") {
    entry.result = typeof evt.result === "string" ? evt.result : (entry.result || "");
    // The newest turn is the one this process is answering (see startRun/
    // continueRun) -- its reply is what the Agent tab's chat history shows.
    if (entry.turns && entry.turns.length) entry.turns[entry.turns.length - 1].result = entry.result;
    // If nothing rendered as running commentary (e.g. the agent answered in
    // one shot with no tool calls), fall back to showing the final result
    // in the terminal panel too rather than leaving it blank.
    if (!entry.output.trim() && entry.result) entry.output = entry.result;
  }
}

// Finds the on-disk transcript for a Claude Code session id that this app
// never itself tracked as an agent run -- e.g. one calendar-extract.js or
// the Notes tab's /api/chat spawned with its own --session-id, outside
// agent-runtime.js entirely (see those callers' own comments on why: each
// is a one-shot `claude -p` call, not a long-lived Agent-tab-style run).
// Those still write a normal, real session transcript to disk -- Claude
// Code itself does that regardless of who spawned it -- just under
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl, keyed by whatever cwd
// that particular spawn() call used. Rather than assume any one cwd (this
// app spawns Claude from more than one: see REPO_ROOT in agent-routes.js vs
// the server process's own cwd in calendar-extract.js), this just checks
// every project directory for a file with this session's name.
function findSessionTranscriptPath(sessionId){
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch (err) { return null; }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// A project directory's name is just its real absolute path with every "/"
// swapped for "-" (see findSessionTranscriptPath) -- reversing that swap
// recovers the cwd a session was originally spawned from, which a follow-up
// `claude --resume` needs to pass as its own cwd (sessions are scoped per
// project directory; resuming from the wrong one fails to find it). Falls
// back to null (letting the caller default to REPO_ROOT) if the reversed
// path doesn't actually exist, rather than trusting a guess blindly.
function cwdFromProjectDirName(dirName){
  const guess = dirName.replace(/-/g, "/");
  try { return fs.statSync(guess).isDirectory() ? guess : null; } catch (err) { return null; }
}

// Reads a session transcript file (JSON Lines, one persisted message per
// line -- the same shape stream-json events have, since both come from the
// same underlying Agent SDK) and reduces it to the same {output, result}
// shape handleStreamEvent builds live, so an adopted session renders in the
// Agent tab's terminal/output panels exactly like a run this app started
// itself. Returns null if no transcript for this session id exists on disk
// at all (a session id that was never real, or whose transcript has since
// been pruned).
async function loadExternalSession(sessionId){
  const transcriptPath = findSessionTranscriptPath(sessionId);
  if (!transcriptPath) return null;

  const raw = fs.readFileSync(transcriptPath, "utf8");
  let output = "", result = "", title = null;
  // One {prompt, result} per typed user message, result being the last
  // assistant text before the next one -- same shape startRun/continueRun
  // record live, so the Agent tab's chat history works for these too.
  const turns = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch (err) { continue; }
    if (!evt || typeof evt !== "object") continue;

    if (evt.type === "ai-title" && evt.aiTitle && !title) {
      title = evt.aiTitle;
    } else if (evt.type === "user" && evt.message) {
      const content = evt.message.content;
      if (typeof content === "string") {
        output += `> ${content}\n\n`;
        turns.push({ prompt: content, result: "" });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === "tool_result") {
            const text = toolResultText(block.content);
            if (text) output += indentBlock(text) + "\n";
          }
        }
      }
    } else if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
      let msgText = "";
      for (const block of evt.message.content) {
        if (!block) continue;
        if (block.type === "text" && block.text) {
          output += block.text;
          msgText += block.text;
        } else if (block.type === "tool_use") {
          output += `\n\n$ ${block.name || "tool"}${formatToolInput(block.input)}\n`;
        }
      }
      if (msgText.trim()) {
        result = msgText;
        if (turns.length) turns[turns.length - 1].result = msgText;
      }
    }
  }

  return {
    output,
    result,
    turns,
    title,
    cwd: cwdFromProjectDirName(path.basename(path.dirname(transcriptPath)))
  };
}

// Shared by startRun and continueRun below -- everything from spawning the
// child process through wiring up its stdout/stderr/close handlers is
// identical between "start a brand-new session" and "resume an existing one
// with a follow-up message"; only the CLI args differ (--session-id vs
// --resume), and the caller has already set up `entry` (fresh for a new run,
// seeded with the prior transcript for a follow-up) and registered it in
// liveRuns.
function spawnClaude(entry, userId, runId, args, cwd){
  let child;
  try {
    child = spawn("claude", args, {
      cwd,
      env: process.env,
      // Nothing ever writes to this process's stdin -- left open (the
      // default), the CLI waits briefly to see if piped input is coming
      // ("no stdin data received in 3s...") before proceeding. Closing it
      // immediately tells it up front there's none, skipping that wait.
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    entry.status = "error";
    entry.output += `Failed to start Claude Code: ${err.message}`;
    agentStore.updateRun(userId, runId, { status: "error", output: entry.output, result: entry.result, turns: entry.turns });
    liveRuns.delete(runId);
    return;
  }
  entry.child = child;

  // stream-json is newline-delimited -- a chunk boundary can land mid-line,
  // so only complete lines (up to the last "\n") are parsed; the remainder
  // stays buffered until the next chunk (or process exit) completes it.
  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      try {
        handleStreamEvent(entry, JSON.parse(line));
      } catch (err) {
        // Not valid JSON -- show it verbatim rather than silently dropping
        // it, in case it's a diagnostic line the CLI printed outside the
        // stream-json protocol.
        entry.output += line + "\n";
      }
    }
    scheduleFlush(userId, runId);
  });

  child.stderr.on("data", (chunk) => {
    entry.output += chunk.toString();
    scheduleFlush(userId, runId);
  });

  // Fires when the "claude" binary itself can't be found/executed (e.g. not
  // installed, or not on this process's PATH) -- distinct from "close",
  // which fires after the process actually ran.
  child.on("error", (err) => {
    entry.status = "error";
    entry.output += `\n[failed to start: ${err.message}]`;
    agentStore.updateRun(userId, runId, { status: "error", output: entry.output, result: entry.result, turns: entry.turns });
    liveRuns.delete(runId);
  });

  child.on("close", (code) => {
    if (stdoutBuffer.trim()) {
      try {
        handleStreamEvent(entry, JSON.parse(stdoutBuffer));
      } catch (err) {
        entry.output += stdoutBuffer;
      }
    }
    entry.status = code === 0 ? "done" : "error";
    agentStore.updateRun(userId, runId, { status: entry.status, output: entry.output, result: entry.result, turns: entry.turns });
    liveRuns.delete(runId);
  });
}

// -p (print mode) is what makes this non-interactive: one turn, then exit --
// no TTY or approval prompts to hang on. --permission-mode auto lets it
// proceed through routine tool calls on its own since nobody's watching a
// terminal to approve them here.
//
// --session-id runId reuses the Agent tab's own run id (already a UUID) as
// the Claude Code session id, instead of letting the CLI generate a random
// one -- that's what makes a run findable afterward from an SSH session:
// `cd` into the repo (sessions are scoped per project directory) and run
// `claude --resume <runId>` to open that exact conversation, or just
// `claude --resume` for the interactive picker, which will list it among
// recent sessions since it's a real persisted session like any other.
function startRun(userId, runId, prompt, cwd){
  const entry = { userId, output: "", result: "", turns: [{ prompt, result: "" }], status: "running", child: null };
  liveRuns.set(runId, entry);
  spawnClaude(entry, userId, runId, [
    "-p", prompt,
    "--permission-mode", "auto",
    "--output-format", "stream-json",
    "--verbose",
    "--session-id", runId
  ], cwd);
}

// Sends a follow-up message into an already-finished run's own Claude Code
// session, so the Agent tab's chatbox can keep a conversation going instead
// of every message starting a brand-new, context-less session. --resume
// runId picks the exact conversation back up (same session id --session-id
// gave it originally); the transcript in agent-store.js is seeded with the
// prior run's own output/result first so the terminal panel shows one
// continuous conversation rather than resetting to blank on every message.
// Callers (agent-routes.js) are responsible for checking the run isn't
// already live before calling this -- two overlapping `claude --resume`
// invocations against the same session would race each other.
async function continueRun(userId, runId, followupPrompt, cwd){
  const stored = await agentStore.getRun(userId, runId);
  const priorOutput = (stored && stored.output) || "";
  // Runs saved before turns existed only have their first prompt/result --
  // seed the history from those so the earlier exchange isn't lost.
  const priorTurns = (stored && Array.isArray(stored.turns) && stored.turns.length)
    ? stored.turns
    : (stored && (stored.prompt || stored.result) ? [{ prompt: stored.prompt || "", result: stored.result || "" }] : []);
  const entry = {
    userId,
    output: priorOutput + (priorOutput ? "\n\n" : "") + `> ${followupPrompt}\n`,
    result: (stored && stored.result) || "",
    turns: priorTurns.concat([{ prompt: followupPrompt, result: "" }]),
    status: "running",
    child: null
  };
  liveRuns.set(runId, entry);
  spawnClaude(entry, userId, runId, [
    "--resume", runId,
    "-p", followupPrompt,
    "--permission-mode", "auto",
    "--output-format", "stream-json",
    "--verbose"
  ], cwd);
}

function getLiveRun(runId){
  return liveRuns.get(runId) || null;
}

// Used when a run is deleted from the Agent tab while still in flight --
// kills the underlying claude process rather than leaving it running with
// nowhere for its output to go (agent-store.js's updateRun becomes a no-op
// once the run's record is gone, so it would just be wasted work/spend).
function killRun(runId){
  const entry = liveRuns.get(runId);
  if (entry && entry.child) {
    try { entry.child.kill(); } catch (err) { /* already exited */ }
  }
  liveRuns.delete(runId);
}

module.exports = { startRun, continueRun, getLiveRun, killRun, loadExternalSession };
