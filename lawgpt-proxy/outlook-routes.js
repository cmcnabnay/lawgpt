// Outlook (Microsoft Graph) integration for the Tasks tab: OAuth connect
// flow + read-only inbox access. Requires an Azure AD "app registration"
// under the user's own Microsoft account (see the Tasks tab's setup
// instructions in the app) -- there is no way to provision that from code,
// it's a one-time manual step in portal.azure.com.
//
// Scope is deliberately read-only (Mail.Read) -- this never sends mail or
// modifies the mailbox, it only reads messages so they can be summarized
// into a task list.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const router = express.Router();

const ENV_PATH = path.join(__dirname, ".env");
const TOKENS_PATH = path.join(__dirname, "outlook-tokens.json");
const SCOPES = ["offline_access", "User.Read", "Mail.Read"].join(" ");

function getConfig(){
  return {
    clientId: process.env.OUTLOOK_CLIENT_ID || "",
    clientSecret: process.env.OUTLOOK_CLIENT_SECRET || "",
    tenantId: process.env.OUTLOOK_TENANT_ID || "common",
    redirectUri: process.env.OUTLOOK_REDIRECT_URI || "http://localhost:3000/api/outlook/callback",
    // Lets /messages read a specific folder (e.g. one an inbox rule files
    // forwarded mail into) instead of the main Inbox -- handy for keeping
    // forwarded mail from another account separate from personal mail.
    mailFolder: process.env.OUTLOOK_MAIL_FOLDER || "Inbox"
  };
}

// Same "local dev machine only" guard server.js uses for the Settings panel.
function requireLocalhost(req, res, next){
  const ip = req.ip || req.connection.remoteAddress || "";
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isLocal){
    return res.status(403).json({ error: { message: "Outlook settings can only be changed from localhost." } });
  }
  next();
}

// Writes/updates one or more KEY=value lines in .env without disturbing
// anything else already there (mirrors server.js's upsertEnvKey, generalized
// to several keys at once so a single Save writes all three Outlook fields
// together).
function upsertEnvVars(vars){
  let lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const remaining = new Map(Object.entries(vars));
  lines = lines.map(line => {
    for (const [key, value] of remaining){
      if (line.startsWith(key + "=")){
        remaining.delete(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });
  for (const [key, value] of remaining){
    lines.push(`${key}=${value}`);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  // { mode } on writeFileSync only takes effect when the file doesn't
  // already exist yet -- it silently does nothing to an existing file's
  // permissions, so chmod is needed explicitly to actually lock this down
  // every time (the .env being edited here almost always already exists).
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
  Object.entries(vars).forEach(([key, value]) => { process.env[key] = value; });
}

function readTokens(){
  try{ return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")); } catch(e){ return null; }
}
function writeTokens(tokens){
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(TOKENS_PATH, 0o600); // see upsertEnvVars -- mode is a no-op on an existing file (token refreshes overwrite this)
}
function clearTokens(){
  try{ fs.unlinkSync(TOKENS_PATH); } catch(e){ /* already gone */ }
}

router.get("/status", (req, res) => {
  const cfg = getConfig();
  const tokens = readTokens();
  res.json({
    configured: Boolean(cfg.clientId && cfg.clientSecret),
    connected: Boolean(tokens && tokens.refresh_token),
    email: tokens ? (tokens.account_email || null) : null
  });
});

// Saves the Azure app's Client ID/Secret/Tenant ID pasted into Settings.
router.post("/config", requireLocalhost, (req, res) => {
  const { clientId, clientSecret, tenantId, mailFolder } = req.body || {};
  if (!clientId || !clientSecret || typeof clientId !== "string" || typeof clientSecret !== "string"){
    return res.status(400).json({ error: { message: "Client ID and Client Secret are both required." } });
  }
  try{
    // A blank Tenant ID/Mail folder means "leave it as it is", not "reset to
    // the default" -- previously any resave (e.g. after only changing the
    // secret) with that field left blank silently reset an already-working
    // single-tenant Tenant ID back to "common", breaking the OAuth flow with
    // an AADSTS50194 error.
    const current = getConfig();
    upsertEnvVars({
      OUTLOOK_CLIENT_ID: clientId.trim(),
      OUTLOOK_CLIENT_SECRET: clientSecret.trim(),
      OUTLOOK_TENANT_ID: (tenantId && tenantId.trim()) || current.tenantId,
      OUTLOOK_MAIL_FOLDER: (mailFolder && mailFolder.trim()) || current.mailFolder
    });
    res.json({ ok: true });
  } catch(err){
    console.error("Failed to write Outlook config to .env:", err);
    res.status(500).json({ error: { message: "Saved in memory, but couldn't write .env to disk." } });
  }
});

router.get("/connect", (req, res) => {
  const cfg = getConfig();
  if (!cfg.clientId || !cfg.clientSecret){
    return res.status(400).send(
      "Outlook isn't configured yet. Open LawGPT's Settings panel and paste in your Azure app's " +
      "Client ID and Client Secret first (Tasks tab has the full setup steps)."
    );
  }
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = new URL(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", cfg.redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  res.redirect(authUrl.toString());
});

router.get("/callback", async (req, res) => {
  const cfg = getConfig();
  const { code, error, error_description } = req.query;
  if (error){
    return res.redirect(`/lawgpt.html?outlookError=${encodeURIComponent(error_description || error)}#tasks`);
  }
  if (!code){
    return res.status(400).send("Missing authorization code from Microsoft.");
  }
  try{
    const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code: String(code),
        redirect_uri: cfg.redirectUri,
        grant_type: "authorization_code",
        scope: SCOPES
      })
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(data.error_description || data.error || "Token exchange failed.");

    let email = null;
    try{
      const meRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
        headers: { Authorization: `Bearer ${data.access_token}` }
      });
      const me = await meRes.json();
      if (meRes.ok) email = me.mail || me.userPrincipalName || null;
    } catch(e){ /* non-critical -- connection still works without a display email */ }

    writeTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      account_email: email
    });
    res.redirect("/lawgpt.html#tasks");
  } catch(err){
    console.error("Outlook token exchange failed:", err);
    res.redirect(`/lawgpt.html?outlookError=${encodeURIComponent(err.message)}#tasks`);
  }
});

router.post("/disconnect", (req, res) => {
  clearTokens();
  res.json({ ok: true });
});

async function getValidAccessToken(){
  const cfg = getConfig();
  let tokens = readTokens();
  if (!tokens || !tokens.refresh_token) return null;
  if (tokens.expires_at && Date.now() < tokens.expires_at - 60000){
    return tokens.access_token;
  }
  const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
      scope: SCOPES
    })
  });
  const data = await tokenRes.json();
  if (!tokenRes.ok){
    // A refresh token can be revoked/expired -- clear state so the UI shows
    // "Connect" again instead of silently failing on every request.
    clearTokens();
    throw new Error(data.error_description || data.error || "Outlook session expired -- please reconnect.");
  }
  tokens = {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000
  };
  writeTokens(tokens);
  return tokens.access_token;
}

// Graph returns email bodies as HTML by default -- strip to plain text
// (cheerio is already a dependency, used the same way for Canvas imports).
function htmlToPlainText(html){
  if (!html) return "";
  const $ = cheerio.load(html);
  $("style, script").remove();
  return $.root().text().replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// "Inbox" (and other well-known names like "SentItems"/"Drafts") works
// directly in the /mailFolders/{name}/ URL path, but a custom folder (e.g.
// one an inbox rule files forwarded mail into) only has an opaque id, not a
// path-usable name -- so it has to be looked up by displayName first.
async function resolveFolderId(accessToken, folderName){
  if (!folderName || folderName.toLowerCase() === "inbox") return "Inbox";
  const filter = `displayName eq '${String(folderName).replace(/'/g, "''")}'`;
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders?$filter=${encodeURIComponent(filter)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || "Failed to look up the configured mail folder.");
  const match = (data.value || [])[0];
  if (!match){
    throw new Error(`Mail folder "${folderName}" wasn't found. Check the folder name in Settings matches exactly (case-sensitive) what you named it in Outlook.`);
  }
  return match.id;
}

router.get("/messages", async (req, res) => {
  try{
    const accessToken = await getValidAccessToken();
    if (!accessToken){
      return res.status(401).json({ error: { message: "Outlook isn't connected yet." } });
    }
    const cfg = getConfig();
    const folderId = await resolveFolderId(accessToken, cfg.mailFolder);
    const top = Math.min(50, Math.max(1, parseInt(req.query.top, 10) || 25));
    const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages` +
      `?$top=${top}&$select=subject,from,receivedDateTime,bodyPreview,body,isRead&$orderby=receivedDateTime desc`;
    const msgRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await msgRes.json();
    if (!msgRes.ok) throw new Error((data.error && data.error.message) || "Failed to fetch messages.");

    const messages = (data.value || []).map(m => ({
      id: m.id,
      subject: m.subject || "(no subject)",
      from: (m.from && m.from.emailAddress)
        ? `${m.from.emailAddress.name || ""} <${m.from.emailAddress.address || ""}>`.trim()
        : "(unknown sender)",
      receivedAt: m.receivedDateTime,
      isRead: Boolean(m.isRead),
      // Capped per message so a handful of long emails can't blow out the
      // prompt sent to /api/chat for task extraction.
      bodyText: htmlToPlainText(m.body && m.body.content).slice(0, 4000)
    }));
    res.json({ messages });
  } catch(err){
    console.error("Outlook /messages error:", err);
    res.status(500).json({ error: { message: err.message || "Failed to fetch Outlook messages." } });
  }
});

module.exports = router;
