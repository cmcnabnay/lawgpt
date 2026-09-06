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
const agentStore = require("./agent-store");

const liveRuns = new Map(); // runId -> { userId, output, result, status, child }
const flushTimers = new Map();
const FLUSH_INTERVAL_MS = 1500;
const MAX_TOOL_RESULT_CHARS = 4000;

function scheduleFlush(userId, runId){
  if (flushTimers.has(runId)) return;
  flushTimers.set(runId, setTimeout(async () => {
    flushTimers.delete(runId);
    const entry = liveRuns.get(runId);
    if (!entry) return;
    await agentStore.updateRun(userId, runId, { output: entry.output, result: entry.result, status: entry.status });
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
    // If nothing rendered as running commentary (e.g. the agent answered in
    // one shot with no tool calls), fall back to showing the final result
    // in the terminal panel too rather than leaving it blank.
    if (!entry.output.trim() && entry.result) entry.output = entry.result;
  }
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
  const entry = { userId, output: "", result: "", status: "running", child: null };
  liveRuns.set(runId, entry);

  let child;
  try {
    child = spawn("claude", [
      "-p", prompt,
      "--permission-mode", "auto",
      "--output-format", "stream-json",
      "--verbose",
      "--session-id", runId
    ], {
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
    entry.output = `Failed to start Claude Code: ${err.message}`;
    agentStore.updateRun(userId, runId, { status: "error", output: entry.output });
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
    agentStore.updateRun(userId, runId, { status: "error", output: entry.output, result: entry.result });
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
    agentStore.updateRun(userId, runId, { status: entry.status, output: entry.output, result: entry.result });
    liveRuns.delete(runId);
  });
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

module.exports = { startRun, getLiveRun, killRun };
