// email-store.js
//
// Per-account store for synced email metadata -- each user's messages,
// done-flags, and generated plans, one row per message in the
// `email_messages` table (`data` holds the whole message object). The
// mailbox itself is the source of truth for the messages, but which ones
// have already been synced (and their course classification, and whether
// the user marked them done) has to survive a server restart on its own.
//
// One row per message, not the single users.email_sync_state.messages
// array they used to live in: with the array, marking one email done or
// saving one plan read and rewrote every stored email body. Here those are
// single-row UPDATEs that return just that message.
//
// The Graph delta watermark for the synced folder (only "Forwarded" is
// synced, see email-routes.js's /sync) is the users.email_delta_link
// column -- just the URL; it's the old users.email_sync_state column,
// renamed and narrowed once the messages moved out of it.
//
// Requires (run once against the Supabase app_user DB):
//
//   ALTER TABLE users RENAME COLUMN email_sync_state TO email_delta_link;
//   ALTER TABLE users ALTER COLUMN email_delta_link DROP DEFAULT,
//     ALTER COLUMN email_delta_link DROP NOT NULL,
//     ALTER COLUMN email_delta_link TYPE TEXT USING email_delta_link->'deltaLinks'->>'forwarded';
//
//   CREATE TABLE IF NOT EXISTS email_messages (
//     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//     id TEXT NOT NULL,
//     data JSONB NOT NULL,
//     received_at TEXT GENERATED ALWAYS AS (data->>'date') STORED,
//     PRIMARY KEY (user_id, id)
//   );
//   CREATE INDEX IF NOT EXISTS email_messages_user_received_idx ON email_messages(user_id, received_at DESC);
//   GRANT SELECT, INSERT, UPDATE, DELETE ON email_messages TO app_user;
//   CREATE POLICY app_user_full_access ON email_messages
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

// The stored watermark, or undefined if there isn't one yet.
async function getDeltaLink(userId){
  if (!appPool || !userId) return undefined;
  const result = await appPool.query("SELECT email_delta_link FROM users WHERE id = $1", [userId]);
  return (result.rows[0] && result.rows[0].email_delta_link) || undefined;
}

// Ids of every stored message -- what /sync needs to skip mail it already
// has, without pulling any bodies.
async function getIds(userId){
  if (!appPool || !userId) return new Set();
  const result = await appPool.query("SELECT id FROM email_messages WHERE user_id = $1", [userId]);
  return new Set(result.rows.map(r => String(r.id)));
}

// Inserts newly-synced messages and advances the delta watermark (a Graph
// "@odata.deltaLink" URL -- passing it back as the next request's URL is
// how Graph's delta query returns only what changed since last time).
// Deduped by message id, since a delta response can include an
// already-seen message again if it merely changed (e.g. read status) -- an
// existing row is left untouched.
async function addMessages(userId, newMessages, deltaLink){
  if (!appPool || !userId) return;
  for (const msg of newMessages) {
    await appPool.query(
      "INSERT INTO email_messages (user_id, id, data) VALUES ($1, $2, $3) ON CONFLICT (user_id, id) DO NOTHING",
      [userId, String(msg.id), JSON.stringify(msg)]
    );
  }
  if (deltaLink) {
    await appPool.query("UPDATE users SET email_delta_link = $1 WHERE id = $2", [deltaLink, userId]);
  }
}

// Every message, newest first -- the Email tab's list.
async function getAll(userId){
  if (!appPool || !userId) return [];
  const result = await appPool.query(
    "SELECT data FROM email_messages WHERE user_id = $1 ORDER BY received_at DESC NULLS LAST",
    [userId]
  );
  return result.rows.map(r => r.data);
}

async function getMessage(userId, id){
  if (!appPool || !userId || id == null) return null;
  const result = await appPool.query(
    "SELECT data FROM email_messages WHERE user_id = $1 AND id = $2",
    [userId, String(id)]
  );
  return result.rows[0] ? result.rows[0].data : null;
}

// Messages /sync's reclassification pass needs to look at: not hand-filed,
// and either classified under older rules or still uncategorized.
async function getStaleForReclassify(userId, classifierVersion){
  if (!appPool || !userId) return [];
  const result = await appPool.query(
    `SELECT data FROM email_messages
     WHERE user_id = $1
       AND coalesce((data->>'courseManual')::boolean, false) = false
       AND (coalesce(data->>'classifierVersion', '') <> $2 OR data->>'courseFolder' = 'uncategorized')`,
    [userId, String(classifierVersion)]
  );
  return result.rows.map(r => r.data);
}

// Removes a message from the local store -- called after it's been deleted
// from the actual mailbox via Graph (see email-routes.js's DELETE route), so
// the two stay in sync. Not re-added on the next sync since a delta query
// only returns what's new/changed, and a message we deleted ourselves is
// neither.
async function deleteMessage(userId, id){
  if (!appPool || !userId) return false;
  const result = await appPool.query(
    "DELETE FROM email_messages WHERE user_id = $1 AND id = $2",
    [userId, String(id)]
  );
  return result.rowCount > 0;
}

async function markDone(userId, id, done){
  return updateMessage(userId, id, { done: Boolean(done) });
}

// Generic patch used by the plan-generation and agent-run endpoints in
// email-routes.js -- merges the given fields onto the stored message rather
// than needing a bespoke setter for every new field those features track
// (plan text, plan errors, agent status/log/timestamps). One row, no read
// beforehand; returns the updated message, or null if there's no such id.
async function updateMessage(userId, id, patch){
  if (!appPool || !userId) return null;
  const result = await appPool.query(
    "UPDATE email_messages SET data = data || $3::jsonb WHERE user_id = $1 AND id = $2 RETURNING data",
    [userId, String(id), JSON.stringify(patch || {})]
  );
  return result.rows[0] ? result.rows[0].data : null;
}

module.exports = { getDeltaLink, getIds, addMessages, getAll, getMessage, getStaleForReclassify, deleteMessage, markDone, updateMessage };
