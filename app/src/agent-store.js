// agent-store.js
//
// Per-account store for "Send to agent" runs (the Agent tab). Each run is
// one headless invocation of the Claude Code CLI (see agent-runtime.js),
// kept as an entry in this user's own `agent_runs` column (see
// ~/Documents/setup-user-accounts.sql) so past runs and their full output
// survive a server restart and are scoped to the account that started them
// -- the same app_user-backed per-user JSONB pattern already used for
// user_state and email_sync_state.

const SUPABASE_APP_DB_URL = process.env.SUPABASE_APP_DB_URL || "";
let appPool = null;
if (SUPABASE_APP_DB_URL) {
  const { Pool } = require("pg");
  appPool = new Pool({
    connectionString: SUPABASE_APP_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
}

async function load(userId){
  if (!appPool || !userId) return [];
  const result = await appPool.query("SELECT agent_runs FROM users WHERE id = $1", [userId]);
  const runs = result.rows[0] && result.rows[0].agent_runs;
  return Array.isArray(runs) ? runs : [];
}

async function save(userId, runs){
  if (!appPool || !userId) return;
  await appPool.query("UPDATE users SET agent_runs = $1 WHERE id = $2", [JSON.stringify(runs), userId]);
}

async function getAll(userId){
  const runs = await load(userId);
  return runs.slice().sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

async function getRun(userId, id){
  const runs = await load(userId);
  return runs.find(r => String(r.id) === String(id)) || null;
}

async function createRun(userId, { id, title, prompt, source }){
  const runs = await load(userId);
  const run = {
    id,
    title: (title && title.trim()) || "Agent run",
    prompt,
    source: source || null,
    status: "running",
    output: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  runs.push(run);
  await save(userId, runs);
  return run;
}

// Generic patch used by agent-runtime.js as it streams output and again when
// the run finishes -- merges rather than needing a bespoke setter per field.
async function updateRun(userId, id, patch){
  const runs = await load(userId);
  const run = runs.find(r => String(r.id) === String(id));
  if (!run) return null;
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  await save(userId, runs);
  return run;
}

module.exports = { getAll, getRun, createRun, updateRun };
