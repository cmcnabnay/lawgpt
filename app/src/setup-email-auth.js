// setup-email-auth.js
//
// One-time interactive login for the Email tab's mailbox access, run by
// hand from a terminal:
//
//   node app/src/setup-email-auth.js
//
// This is deliberately NOT a web route -- device code flow needs a human
// watching a terminal (for the code) and a browser (to approve it), which
// doesn't fit a fetch()-driven "Sync now" button. Run this once; it prints
// a URL and a short code, you approve the sign-in in any browser, and the
// resulting refresh token is cached to msal-token-cache.json (gitignored)
// for the running proxy server to reuse silently from then on via
// email-auth.js's getAccessTokenSilent(). Re-run this again any time
// /api/email/sync starts reporting that silent refresh failed.
//
// Requires EMAIL_CLIENT_ID to already be set (in ~/.bashrc or
// app/.env) -- see email-auth.js's header comment for how to get
// one (register a free app at https://entra.microsoft.com).

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { getPca, getClientConfig, SCOPES } = require("./email-auth");

async function main(){
  const { clientId } = getClientConfig();
  if (!clientId) {
    console.error(
      "EMAIL_CLIENT_ID isn't set (checked ~/.bashrc and app/.env).\n" +
      "Register a free app at https://entra.microsoft.com (App registrations -> New registration,\n" +
      "'Personal Microsoft accounts only', enable 'Allow public client flows' under Authentication,\n" +
      "add the Mail.ReadWrite delegated permission under API permissions), then set EMAIL_CLIENT_ID to its\n" +
      "Application (client) ID and re-run this script."
    );
    process.exit(1);
  }

  const pca = getPca();

  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.log("\n" + response.message + "\n");
    }
  });

  console.log(`Signed in as ${result.account.username}. Token cached -- the proxy server can now sync this mailbox without asking you to sign in again.`);
  process.exit(0);
}

main().catch(err => {
  console.error("Sign-in failed:", err.message);
  process.exit(1);
});
