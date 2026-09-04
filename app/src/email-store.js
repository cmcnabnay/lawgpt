// email-store.js
//
// Disk-persisted store for synced email metadata. Unlike document-store.js
// (an in-memory Map that local-scan.js rebuilds on every startup by
// rescanning documents/ on disk), there's no folder to rescan here -- the
// mailbox itself is the source of truth for the messages, but which ones
// we've already synced (and their assignment/course classification, and
// whether the user marked them done) has to survive a server restart on
// its own, so it's written to a JSON file.
//
// deltaLinks is keyed per source folder (currently "forwarded" and "junk",
// see email-routes.js) rather than a single watermark -- Outlook's own
// junk-mail filtering runs before inbox rules, so mail that should have
// been moved into the "Forwarded" folder can land in Junk instead; syncing
// both folders (Junk filtered to just uh.edu senders) recovers those
// without depending on Outlook's Safe-senders list actually working.

const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "email-state.json");

function load(){
  if (!fs.existsSync(STATE_PATH)) {
    return { deltaLinks: {}, messages: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    // Older state files (before per-folder sync) stored a single top-level
    // deltaLink for what was implicitly the "forwarded" folder -- carry
    // that forward instead of losing it and re-fetching that folder's
    // whole history.
    const deltaLinks = (parsed.deltaLinks && typeof parsed.deltaLinks === "object")
      ? parsed.deltaLinks
      : (parsed.deltaLink ? { forwarded: parsed.deltaLink } : {});
    return {
      deltaLinks,
      messages: Array.isArray(parsed.messages) ? parsed.messages : []
    };
  } catch (err) {
    console.warn("email-store: couldn't parse email-state.json, starting fresh:", err.message);
    return { deltaLinks: {}, messages: [] };
  }
}

function save(state){
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Appends newly-synced messages for one source folder and advances that
// folder's delta watermark (a Graph "@odata.deltaLink" URL -- passing it
// back as the next request's URL is how Graph's delta query returns only
// what changed since last time) in one write. Deduped by message id, since
// a delta response can include an already-seen message again if it merely
// changed (e.g. read status) -- without this, re-syncing would pile up
// duplicate rows for the same email instead of just updating nothing.
function addMessages(newMessages, folderKey, deltaLink){
  const state = load();
  state.deltaLinks[folderKey] = deltaLink;

  const existingIds = new Set(state.messages.map(m => m.id));
  for (const msg of newMessages) {
    if (!existingIds.has(msg.id)) {
      state.messages.push(msg);
      existingIds.add(msg.id);
    }
  }

  save(state);
  return state;
}

function getAll(){
  return load().messages.slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

function getMessage(id){
  return load().messages.find(m => String(m.id) === String(id)) || null;
}

// Removes a message from the local store -- called after it's been deleted
// from the actual mailbox via Graph (see email-routes.js's DELETE route), so
// the two stay in sync. Not re-added on the next sync since a delta query
// only returns what's new/changed, and a message we deleted ourselves is
// neither.
function deleteMessage(id){
  const state = load();
  const index = state.messages.findIndex(m => String(m.id) === String(id));
  if (index === -1) return false;
  state.messages.splice(index, 1);
  save(state);
  return true;
}

function markDone(id, done){
  const state = load();
  const message = state.messages.find(m => String(m.id) === String(id));
  if (!message) return null;
  message.done = Boolean(done);
  save(state);
  return message;
}

// Generic patch used by the plan-generation and agent-run endpoints in
// email-routes.js -- merges the given fields onto the stored message rather
// than needing a bespoke setter for every new field those features track
// (plan text, plan errors, agent status/log/timestamps).
function updateMessage(id, patch){
  const state = load();
  const message = state.messages.find(m => String(m.id) === String(id));
  if (!message) return null;
  Object.assign(message, patch);
  save(state);
  return message;
}

module.exports = { load, save, addMessages, getAll, getMessage, deleteMessage, markDone, updateMessage };
