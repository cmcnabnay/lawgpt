// document-override-store.js
//
// Backs the Schedule tab's "Replace document" / "Remove document" overrides
// (see the DOC_OVERRIDES section of lawgpt.html). Two layers, same shape as
// each other -- a flat { "<courseCode>␟<identifyingText>": docTitle|null }
// object, keyed exactly the way docMatchKey() on the client builds it:
//
//   - global: one shared object, set only by an 'admin'-role account, and
//     loaded for EVERY visitor (signed in or not) as the baseline default.
//     Stored the same generic way GET/POST /api/db/* would let an admin
//     stash arbitrary settings -- a single row in app_settings.
//   - per-user: one object per account, stored on that account's own row
//     (users.doc_overrides), same JSONB-column-on-users pattern already used
//     for agent_runs/email_sync_state/openai_api_key etc. A signed-in user's
//     own entries win over the global default for any key they've touched;
//     everything else still falls through to the global default.
//
// Requires (run once against the Supabase app_user DB, alongside whatever
// created users/user_state -- see ~/Documents/setup-user-accounts.sql):
//
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
//   CREATE TABLE IF NOT EXISTS app_settings (
//     key   TEXT PRIMARY KEY,
//     value JSONB NOT NULL DEFAULT '{}'::jsonb
//   );
//   GRANT SELECT, INSERT, UPDATE ON app_settings TO app_user;

const SUPABASE_APP_DB_URL = process.env.SUPABASE_APP_DB_URL || "";
let appPool = null;
if (SUPABASE_APP_DB_URL) {
  const { Pool } = require("pg");
  appPool = new Pool({
    connectionString: SUPABASE_APP_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
}

const GLOBAL_SETTINGS_KEY = "schedule_doc_overrides";

async function getGlobal(){
  if (!appPool) return {};
  const result = await appPool.query("SELECT value FROM app_settings WHERE key = $1", [GLOBAL_SETTINGS_KEY]);
  return (result.rows[0] && result.rows[0].value) || {};
}

async function setGlobal(overrides){
  if (!appPool) return;
  await appPool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [GLOBAL_SETTINGS_KEY, JSON.stringify(overrides)]
  );
}

async function getForUser(userId){
  if (!appPool || !userId) return {};
  const result = await appPool.query("SELECT doc_overrides FROM users WHERE id = $1", [userId]);
  return (result.rows[0] && result.rows[0].doc_overrides) || {};
}

async function setForUser(userId, overrides){
  if (!appPool || !userId) return;
  await appPool.query("UPDATE users SET doc_overrides = $1 WHERE id = $2", [JSON.stringify(overrides), userId]);
}

// Everything a freshly-loaded schedule needs: the global default layer plus
// (if signed in) this account's personal layer on top of it. `mine` is {}
// for a signed-out visitor -- the client just applies the global layer alone.
async function getAll(userId){
  const [global, mine] = await Promise.all([
    getGlobal(),
    userId ? getForUser(userId) : Promise.resolve({})
  ]);
  return { global, mine };
}

// value: a document title (string) to force, or null for an explicit "no
// document" override. isAdmin routes the write to the shared global layer
// instead of the calling account's own layer.
async function setOverride({ userId, isAdmin, key, value }){
  if (isAdmin){
    const overrides = await getGlobal();
    overrides[key] = value;
    await setGlobal(overrides);
  } else {
    const overrides = await getForUser(userId);
    overrides[key] = value;
    await setForUser(userId, overrides);
  }
}

// Undoes setOverride for one key, falling back to the next layer down
// (global default, or plain auto-matching if there's no global entry either).
async function clearOverride({ userId, isAdmin, key }){
  if (isAdmin){
    const overrides = await getGlobal();
    delete overrides[key];
    await setGlobal(overrides);
  } else {
    const overrides = await getForUser(userId);
    delete overrides[key];
    await setForUser(userId, overrides);
  }
}

module.exports = { getAll, setOverride, clearOverride };
