// agent-store.js
//
// Per-account store for "Send to agent" runs (the Agent tab). Each run is
// one headless invocation of the Claude Code CLI (see agent-runtime.js),
// kept as its own row in the `agent_runs` table so past runs and their full
// output survive a server restart and are scoped to the account that
// started them.
//
// One row per run, not one JSONB array per user (the old users.agent_runs
// column): with the array, every read or patch of one run had to load every
// run's full transcript, and the 1.5s flush/poll while a run streamed made
// that most of the app's Supabase egress. Here the list query never selects
// transcripts, updateRun is write-only, and getRun reads just the one row.
//
// Requires (run once against the Supabase app_user DB):
//
//   CREATE TABLE IF NOT EXISTS agent_runs (
//     id TEXT PRIMARY KEY,
//     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//     title TEXT NOT NULL DEFAULT 'Agent run',
//     prompt TEXT,
//     source JSONB,
//     status TEXT NOT NULL DEFAULT 'running',
//     output TEXT NOT NULL DEFAULT '',
//     result TEXT NOT NULL DEFAULT '',
//     turns JSONB,
//     cwd TEXT,
//     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS agent_runs_user_updated_idx ON agent_runs(user_id, updated_at DESC);
//   GRANT SELECT, INSERT, UPDATE, DELETE ON agent_runs TO app_user;
//   -- RLS stays on (it's what keeps readonly_user/the public query box
//   -- out); app_user gets the same blanket policy as users/user_state:
//   CREATE POLICY app_user_full_access ON agent_runs
//     FOR ALL TO app_user USING (true) WITH CHECK (true);

const SUPABASE_APP_DB_URL = process.env.SUPABASE_APP_DB_URL || "";
let appPool = null;
if (SUPABASE_APP_DB_URL) {
  const { Pool } = require("pg");
  appPool = new Pool({
    connectionString: SUPABASE_APP_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// What the list query, createRun and updateRun return -- everything but the
// (potentially large) prompt/output/result/turns.
const META_COLUMNS = "id, title, status, source, created_at, updated_at";

// Columns updateRun may set, keyed by the camelCase field callers patch.
// JSONB ones are stringified explicitly: node-pg would otherwise send a JS
// array (turns) as a Postgres array rather than JSON.
const PATCHABLE = {
  title: { column: "title" },
  prompt: { column: "prompt" },
  source: { column: "source", json: true },
  status: { column: "status" },
  output: { column: "output" },
  result: { column: "result" },
  turns: { column: "turns", json: true },
  cwd: { column: "cwd" }
};

// Row -> the same camelCase run shape the old JSONB entries had, so
// agent-routes.js and lawgpt.html didn't need to change. Fields a query
// didn't select are simply left off.
function rowToRun(row){
  if (!row) return null;
  const run = {};
  for (const [field, { column }] of Object.entries(PATCHABLE)) {
    if (column in row) run[field] = row[column];
  }
  run.id = row.id;
  if (row.created_at) run.createdAt = new Date(row.created_at).toISOString();
  if (row.updated_at) run.updatedAt = new Date(row.updated_at).toISOString();
  return run;
}

async function getAll(userId){
  if (!appPool || !userId) return [];
  const result = await appPool.query(
    `SELECT ${META_COLUMNS} FROM agent_runs WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId]
  );
  return result.rows.map(rowToRun);
}

// Scoped to the owning user, so this doubles as the access check.
async function getRun(userId, id){
  if (!appPool || !userId || !id) return null;
  const result = await appPool.query(
    "SELECT * FROM agent_runs WHERE id = $1 AND user_id = $2",
    [String(id), userId]
  );
  return rowToRun(result.rows[0]);
}

// output: the terminal-style transcript (commentary, tool calls, tool
// results). result: just the final deliverable text, rendered as compiled
// markdown in the Agent tab's Output panel -- see agent-runtime.js's
// handleStreamEvent for how these two diverge. status/output/result/turns/
// cwd are only passed when adopting an already-finished external session
// (see agent-routes.js's getOrAdoptRun).
async function createRun(userId, { id, title, prompt, source, status, output, result, turns, cwd }){
  if (!appPool || !userId) {
    // No DB configured: nothing is persisted, but callers still need the id
    // and title to start and poll the (in-memory) run.
    return { id: String(id), title: (title && title.trim()) || "Agent run", status: status || "running", source: source || null };
  }
  const res = await appPool.query(
    `INSERT INTO agent_runs (id, user_id, title, prompt, source, status, output, result, turns, cwd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${META_COLUMNS}`,
    [
      String(id),
      userId,
      (title && title.trim()) || "Agent run",
      prompt || "",
      source == null ? null : JSON.stringify(source),
      status || "running",
      output || "",
      result || "",
      turns == null ? null : JSON.stringify(turns),
      cwd || null
    ]
  );
  return rowToRun(res.rows[0]);
}

// Generic patch used by agent-runtime.js as it streams output and again when
// the run finishes. Write-only -- sets just the patched columns and returns
// the run's metadata, never reading the transcript back. Null if the run no
// longer exists (e.g. deleted mid-run).
async function updateRun(userId, id, patch){
  if (!appPool || !userId || !id) return null;
  const sets = [];
  const values = [String(id), userId];
  for (const [field, value] of Object.entries(patch || {})) {
    const spec = PATCHABLE[field];
    if (!spec || value === undefined) continue;
    values.push(spec.json && value != null ? JSON.stringify(value) : value);
    sets.push(`${spec.column} = $${values.length}`);
  }
  sets.push("updated_at = now()");
  const result = await appPool.query(
    `UPDATE agent_runs SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING ${META_COLUMNS}`,
    values
  );
  return rowToRun(result.rows[0]);
}

async function deleteRun(userId, id){
  if (!appPool || !userId || !id) return false;
  const result = await appPool.query(
    "DELETE FROM agent_runs WHERE id = $1 AND user_id = $2",
    [String(id), userId]
  );
  return result.rowCount > 0;
}

module.exports = { getAll, getRun, createRun, updateRun, deleteRun };
