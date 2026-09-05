// email-store.js
//
// Per-account store for synced email metadata -- each user's messages,
// per-folder delta-sync watermarks, done-flags, and generated plans live in
// their own `email_sync_state` column (see ~/Documents/setup-user-accounts.sql),
// the same app_user-backed pattern user_state.js-equivalent code in
// server.js already uses for the notes/chat docket. Unlike document-store.js
// (an in-memory Map rebuilt by rescanning documents/ on disk), there's no
// folder to rescan here -- the mailbox itself is the source of truth for the
// messages, but which ones have already been synced (and their
// assignment/course classification, and whether the user marked them done)
// has to survive a server restart on its own.
//
// deltaLinks is keyed per source folder (currently just "forwarded", see
// email-routes.js) rather than a single watermark -- Outlook's own
// junk-mail filtering runs before inbox rules, so mail that should have
// been moved into a "Forwarded"-style folder can land in Junk instead;
// syncing multiple folders recovers those without depending on Outlook's
// Safe-senders list actually working, should that ever be added back.

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
  if (!appPool || !userId) return { deltaLinks: {}, messages: [] };
  const result = await appPool.query("SELECT email_sync_state FROM users WHERE id = $1", [userId]);
  const parsed = (result.rows[0] && result.rows[0].email_sync_state) || {};
  return {
    deltaLinks: (parsed.deltaLinks && typeof parsed.deltaLinks === "object") ? parsed.deltaLinks : {},
    messages: Array.isArray(parsed.messages) ? parsed.messages : []
  };
}

async function save(userId, state){
  if (!appPool || !userId) return;
  await appPool.query("UPDATE users SET email_sync_state = $1 WHERE id = $2", [JSON.stringify(state), userId]);
}

// Appends newly-synced messages for one source folder and advances that
// folder's delta watermark (a Graph "@odata.deltaLink" URL -- passing it
// back as the next request's URL is how Graph's delta query returns only
// what changed since last time) in one write. Deduped by message id, since
// a delta response can include an already-seen message again if it merely
// changed (e.g. read status) -- without this, re-syncing would pile up
// duplicate rows for the same email instead of just updating nothing.
async function addMessages(userId, newMessages, folderKey, deltaLink){
  const state = await load(userId);
  state.deltaLinks[folderKey] = deltaLink;

  const existingIds = new Set(state.messages.map(m => m.id));
  for (const msg of newMessages) {
    if (!existingIds.has(msg.id)) {
      state.messages.push(msg);
      existingIds.add(msg.id);
    }
  }

  await save(userId, state);
  return state;
}

async function getAll(userId){
  const state = await load(userId);
  return state.messages.slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

async function getMessage(userId, id){
  const state = await load(userId);
  return state.messages.find(m => String(m.id) === String(id)) || null;
}

// Removes a message from the local store -- called after it's been deleted
// from the actual mailbox via Graph (see email-routes.js's DELETE route), so
// the two stay in sync. Not re-added on the next sync since a delta query
// only returns what's new/changed, and a message we deleted ourselves is
// neither.
async function deleteMessage(userId, id){
  const state = await load(userId);
  const index = state.messages.findIndex(m => String(m.id) === String(id));
  if (index === -1) return false;
  state.messages.splice(index, 1);
  await save(userId, state);
  return true;
}

async function markDone(userId, id, done){
  const state = await load(userId);
  const message = state.messages.find(m => String(m.id) === String(id));
  if (!message) return null;
  message.done = Boolean(done);
  await save(userId, state);
  return message;
}

// Generic patch used by the plan-generation and agent-run endpoints in
// email-routes.js -- merges the given fields onto the stored message rather
// than needing a bespoke setter for every new field those features track
// (plan text, plan errors, agent status/log/timestamps).
async function updateMessage(userId, id, patch){
  const state = await load(userId);
  const message = state.messages.find(m => String(m.id) === String(id));
  if (!message) return null;
  Object.assign(message, patch);
  await save(userId, state);
  return message;
}

module.exports = { load, save, addMessages, getAll, getMessage, deleteMessage, markDone, updateMessage };
