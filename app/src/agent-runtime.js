// agent-runtime.js
//
// Runs the Claude Code CLI headlessly for the Agent tab's "Send to agent"
// feature -- a plain background child process, no GUI terminal, so it works
// the same whether the server is on a desktop machine or a headless box like
// EC2 (see email-routes.js's comment history for why the old
// open-a-visible-terminal design couldn't work there at all).
//
// Output is buffered in-memory per run while it's in flight (liveRuns) so
// the Agent tab can poll it cheaply without hitting Supabase on every chunk,
// then flushed to agent-store.js on a short debounce while running and
// always once more on completion -- so a run's output survives a server
// restart and shows up again next time the account signs in, same as
// email/notes state.

const { spawn } = require("child_process");
const agentStore = require("./agent-store");

const liveRuns = new Map(); // runId -> { userId, output, status }
const flushTimers = new Map();
const FLUSH_INTERVAL_MS = 1500;

function scheduleFlush(userId, runId){
  if (flushTimers.has(runId)) return;
  flushTimers.set(runId, setTimeout(async () => {
    flushTimers.delete(runId);
    const entry = liveRuns.get(runId);
    if (!entry) return;
    await agentStore.updateRun(userId, runId, { output: entry.output, status: entry.status });
  }, FLUSH_INTERVAL_MS));
}

// -p (print mode) is what makes this non-interactive: one turn, streamed to
// stdout as it's generated, then exit -- no TTY or approval prompts to hang
// on. --permission-mode auto lets it proceed through routine tool calls on
// its own since nobody's watching a terminal to approve them here.
function startRun(userId, runId, prompt, cwd){
  const entry = { userId, output: "", status: "running" };
  liveRuns.set(runId, entry);

  let child;
  try {
    child = spawn("claude", ["-p", prompt, "--permission-mode", "auto"], {
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

  const appendChunk = (chunk) => {
    entry.output += chunk.toString();
    scheduleFlush(userId, runId);
  };
  child.stdout.on("data", appendChunk);
  child.stderr.on("data", appendChunk);

  // Fires when the "claude" binary itself can't be found/executed (e.g. not
  // installed, or not on this process's PATH) -- distinct from "close",
  // which fires after the process actually ran.
  child.on("error", (err) => {
    entry.status = "error";
    entry.output += `\n[failed to start: ${err.message}]`;
    agentStore.updateRun(userId, runId, { status: "error", output: entry.output });
    liveRuns.delete(runId);
  });

  child.on("close", (code) => {
    entry.status = code === 0 ? "done" : "error";
    agentStore.updateRun(userId, runId, { status: entry.status, output: entry.output });
    liveRuns.delete(runId);
  });
}

function getLiveRun(runId){
  return liveRuns.get(runId) || null;
}

module.exports = { startRun, getLiveRun };
