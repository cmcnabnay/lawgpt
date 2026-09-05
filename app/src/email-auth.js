// email-auth.js
//
// Microsoft Graph OAuth2 for the Email tab. IMAP with a plain app password
// turned out to be a dead end for this account -- Microsoft's IMAP server
// rejects AUTHENTICATE PLAIN/LOGIN outright ("Provided authentication
// mechanism is not supported") even with a valid app password and IMAP
// enabled on the mailbox, because it now requires OAuth2 ("Modern Auth").
// Graph's REST API sidesteps IMAP entirely and just needs a bearer token.
//
// Every function here takes a userId: each account connects its own
// mailbox with its own client ID, independently -- there is no shared
// global mailbox anymore. Client ID, folder, and the MSAL token cache are
// all columns on that account's own row in `users` (see
// ~/Documents/setup-user-accounts.sql), read/written through the same
// app_user Postgres role the rest of the app's per-account data uses.
//
// Signing in (device code flow) happens from the browser via
// /api/email-setup/start + /status in server.js, which call
// acquireTokenByDeviceCode() here in the background -- see that file for
// why this can't be a normal single request/response. This module itself
// never does anything interactive; getAccessTokenSilent() below is the
// only thing routine requests (e.g. /api/email/sync) call, and it never
// prompts -- if there's no cached, refreshable token, it returns a clear
// error telling the caller to (re)connect their mailbox in Settings.

const { PublicClientApplication } = require("@azure/msal-node");

const SUPABASE_APP_DB_URL = process.env.SUPABASE_APP_DB_URL || "";
let appPool = null;
if (SUPABASE_APP_DB_URL) {
  const { Pool } = require("pg");
  appPool = new Pool({
    connectionString: SUPABASE_APP_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// Mail.ReadWrite (not just Mail.Read) -- the Email tab's Delete button
// deletes a message from the actual mailbox via Graph, which Mail.Read
// alone can't authorize (Graph returns "Access is denied" for the DELETE
// call even though sync/reading works fine). ReadWrite is a superset, so
// this single scope still covers everything Mail.Read did.
const SCOPES = ["Mail.ReadWrite"];

async function getEmailConfig(userId){
  if (!appPool || !userId) return { clientId: "", tenantId: "consumers", folder: "" };
  const result = await appPool.query("SELECT email_client_id, email_folder FROM users WHERE id = $1", [userId]);
  const row = result.rows[0] || {};
  return {
    clientId: row.email_client_id || "",
    // Always "consumers" -- correct for a personal outlook.com/hotmail.com
    // account, which is the only kind this app supports.
    tenantId: "consumers",
    folder: row.email_folder || ""
  };
}

async function getClientConfig(userId){
  const { clientId, tenantId } = await getEmailConfig(userId);
  return { clientId, tenantId, authority: `https://login.microsoftonline.com/${tenantId}` };
}

// MSAL's cache plugin hooks are how you make its in-memory token cache
// persist across process restarts -- built fresh per userId (closing over
// it) rather than one shared instance, since each account's cache lives in
// its own row.
function makeCachePlugin(userId){
  return {
    beforeCacheAccess: async (cacheContext) => {
      if (!appPool) return;
      const result = await appPool.query("SELECT email_token_cache FROM users WHERE id = $1", [userId]);
      const cached = result.rows[0] && result.rows[0].email_token_cache;
      if (cached) cacheContext.tokenCache.deserialize(cached);
    },
    afterCacheAccess: async (cacheContext) => {
      if (!appPool || !cacheContext.cacheHasChanged) return;
      await appPool.query(
        "UPDATE users SET email_token_cache = $1 WHERE id = $2",
        [cacheContext.tokenCache.serialize(), userId]
      );
    }
  };
}

async function getPca(userId){
  const { clientId, authority } = await getClientConfig(userId);
  if (!clientId) return null;
  return new PublicClientApplication({
    auth: { clientId, authority },
    cache: { cachePlugin: makeCachePlugin(userId) }
  });
}

// Used by /api/email/sync -- never prompts. Returns null if there's no
// cached account to silently refresh a token for (mailbox hasn't been
// connected yet, or the refresh token was revoked/expired), so the caller
// can return a clear "connect your mailbox" error instead of hanging.
async function getAccessTokenSilent(userId){
  const pca = await getPca(userId);
  if (!pca) return { error: "No email client ID saved to your account yet. Set one in Settings first." };

  const cache = pca.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (!accounts.length) {
    return { error: "No signed-in mailbox account found. Connect your mailbox in Settings." };
  }

  try {
    const result = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
    return { accessToken: result.accessToken, account: accounts[0] };
  } catch (err) {
    return { error: `Couldn't silently refresh the mailbox login (${err.message}). Reconnect your mailbox in Settings.` };
  }
}

// Shared with server.js's own copy of this same lookup (used by /api/chat)
// -- email-routes.js's plan-generation feature needs the signed-in user's
// own OpenAI key too, and already has no DB pool of its own, so it reuses
// this module's appPool rather than duplicating the connection.
async function getPersonalApiKey(userId){
  if (!appPool || !userId) return null;
  const result = await appPool.query("SELECT openai_api_key FROM users WHERE id = $1", [userId]);
  return (result.rows[0] && result.rows[0].openai_api_key) || null;
}

module.exports = { getPca, getClientConfig, getEmailConfig, getAccessTokenSilent, getPersonalApiKey, SCOPES };
