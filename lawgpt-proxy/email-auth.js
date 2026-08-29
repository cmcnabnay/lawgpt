// email-auth.js
//
// Microsoft Graph OAuth2 for the Email tab. IMAP with a plain app password
// turned out to be a dead end for this account -- Microsoft's IMAP server
// rejects AUTHENTICATE PLAIN/LOGIN outright ("Provided authentication
// mechanism is not supported") even with a valid app password and IMAP
// enabled on the mailbox, because it now requires OAuth2 ("Modern Auth").
// Graph's REST API sidesteps IMAP entirely and just needs a bearer token.
//
// Requires EMAIL_CLIENT_ID (and optionally EMAIL_TENANT_ID, default
// "consumers" -- correct for a personal outlook.com/hotmail.com account) in
// ~/.bashrc or lawgpt-proxy/.env -- ~/.bashrc is checked first (see
// readFromBashrc/getEmailConfig below), .env is the fallback for whichever
// of the two doesn't provide it (that order was requested specifically so
// the user doesn't have to keep values in both places in sync). Also used
// by email-routes.js for EMAIL_FOLDER, so this lives here rather than in
// each caller. EMAIL_CLIENT_ID comes from registering a free "public
// client" app in https://entra.microsoft.com -- see setup-email-auth.js.
//
// The one-time interactive login (device code flow) happens in
// setup-email-auth.js, run by hand from a terminal
// (`node lawgpt-proxy/setup-email-auth.js`) -- not from the web UI, since
// device code flow needs a human watching a terminal/browser, not a fetch()
// call. That script and the running proxy server share the token cache
// file below: the server's /api/email/sync route only ever calls
// acquireTokenSilent(), which transparently uses the cached refresh token
// (MSAL renews it automatically on each successful use) and never prompts
// -- if silent acquisition fails, the server tells the caller to re-run the
// setup script rather than attempting any interactive flow itself.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PublicClientApplication } = require("@azure/msal-node");

const CACHE_PATH = path.join(__dirname, "msal-token-cache.json");
const SCOPES = ["Mail.Read"];

// Reads a set of variable names out of ~/.bashrc by actually sourcing it in
// a real bash process (rather than regex-scanning the file, which would
// break on anything conditional -- nvm/conda init blocks, if-guards, etc.)
// and echoing each one back behind a marker. Run with `-i` (interactive)
// because most .bashrc files open with a
// `case $- in *i*) ;; *) return;; esac` guard that skips the rest of the
// file for non-interactive shells -- a plain `bash -c` would hit that guard
// and never actually set anything. stdin is ignored so nothing can block on
// input, and a short timeout plus try/catch means any failure here (no
// ~/.bashrc, bash not on PATH, something in the file erroring out) just
// falls through to .env instead of breaking the caller.
function readFromBashrc(varNames){
  const bashrcPath = path.join(os.homedir(), ".bashrc");
  if (!fs.existsSync(bashrcPath)) return {};

  const marker = "__LAWGPT_ENV__";
  const script =
    `source "${bashrcPath}" >/dev/null 2>&1; ` +
    varNames.map(name => `echo "${marker}:${name}=$${name}"`).join("; ");

  try {
    const output = execFileSync("bash", ["-i", "-c", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000
    });

    const found = {};
    for (const line of output.split("\n")) {
      const m = line.match(new RegExp(`^${marker}:(\\w+)=(.*)$`));
      if (m && m[2]) found[m[1]] = m[2];
    }
    return found;
  } catch (err) {
    return {};
  }
}

function getEmailConfig(){
  const fromBashrc = readFromBashrc(["EMAIL_CLIENT_ID", "EMAIL_TENANT_ID", "EMAIL_FOLDER"]);
  return {
    clientId: fromBashrc.EMAIL_CLIENT_ID || process.env.EMAIL_CLIENT_ID || "",
    tenantId: fromBashrc.EMAIL_TENANT_ID || process.env.EMAIL_TENANT_ID || "consumers",
    folder: fromBashrc.EMAIL_FOLDER || process.env.EMAIL_FOLDER || "Forwarded"
  };
}

// MSAL's cache plugin hooks are how you make its in-memory token cache
// persist across process restarts -- without this, every server restart
// would need a fresh device-code login.
const cachePlugin = {
  beforeCacheAccess: async (cacheContext) => {
    if (fs.existsSync(CACHE_PATH)) {
      cacheContext.tokenCache.deserialize(fs.readFileSync(CACHE_PATH, "utf8"));
    }
  },
  afterCacheAccess: async (cacheContext) => {
    if (cacheContext.cacheHasChanged) {
      fs.writeFileSync(CACHE_PATH, cacheContext.tokenCache.serialize(), { mode: 0o600 });
    }
  }
};

function getClientConfig(){
  const { clientId, tenantId } = getEmailConfig();
  return { clientId, tenantId, authority: `https://login.microsoftonline.com/${tenantId}` };
}

function getPca(){
  const { clientId, authority } = getClientConfig();
  if (!clientId) return null;
  return new PublicClientApplication({
    auth: { clientId, authority },
    cache: { cachePlugin }
  });
}

// Used by /api/email/sync -- never prompts. Returns null if there's no
// cached account to silently refresh a token for (first-time setup hasn't
// been run, or the refresh token was revoked/expired), so the caller can
// return a clear "run the setup script" error instead of hanging.
async function getAccessTokenSilent(){
  const pca = getPca();
  if (!pca) return { error: "EMAIL_CLIENT_ID isn't set -- checked ~/.bashrc and lawgpt-proxy/.env, found neither." };

  const cache = pca.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (!accounts.length) {
    return { error: "No signed-in mailbox account found. Run `node lawgpt-proxy/setup-email-auth.js` once from a terminal to sign in." };
  }

  try {
    const result = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
    return { accessToken: result.accessToken, account: accounts[0] };
  } catch (err) {
    return { error: `Couldn't silently refresh the mailbox login (${err.message}). Run \`node lawgpt-proxy/setup-email-auth.js\` again to sign in.` };
  }
}

module.exports = { getPca, getClientConfig, getAccessTokenSilent, getEmailConfig, SCOPES, CACHE_PATH };
