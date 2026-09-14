// One-time script to write the recovered savedReports (see
// recovered-saved-reports-2026-09-14.json, decoded from the notes/ folder
// backups) into a specific account's saved_reports column.
//
// Prerequisites:
//   1. 2026-09-14-split-user-state-columns.sql has already been run
//      (in the Supabase SQL editor) so the saved_reports column exists.
//   2. SUPABASE_APP_DB_URL is set in app/.env.
//
// Usage:
//   node migrations/restore-saved-reports.js you@example.com
//
// Merges rather than overwrites: appends the recovered entries after
// whatever's already in the account's saved_reports (e.g. anything you've
// re-generated since the wipe), so nothing already there gets clobbered.
// reportCounter is bumped to stay ahead of the newly-added ids.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const email = process.argv[2];
if (!email) {
  console.error("Usage: node migrations/restore-saved-reports.js <account-email>");
  process.exit(1);
}

const recovered = JSON.parse(fs.readFileSync(path.join(__dirname, "recovered-saved-reports-2026-09-14.json"), "utf8"));

async function main(){
  const pool = new Pool({ connectionString: process.env.SUPABASE_APP_DB_URL, ssl: { rejectUnauthorized: false } });
  const userRes = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (!userRes.rows.length) {
    console.error(`No account found for ${email}.`);
    await pool.end();
    process.exit(1);
  }
  const userId = userRes.rows[0].id;

  const stateRes = await pool.query(
    "SELECT saved_reports, report_counter FROM user_state WHERE user_id = $1",
    [userId]
  );
  const existing = stateRes.rows[0] ? (stateRes.rows[0].saved_reports || []) : [];
  const existingCounter = stateRes.rows[0] ? (stateRes.rows[0].report_counter || 0) : 0;

  const merged = existing.concat(recovered);
  const newCounter = existingCounter + recovered.length;

  await pool.query(
    `INSERT INTO user_state (user_id, saved_reports, report_counter, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET
       saved_reports = EXCLUDED.saved_reports,
       report_counter = EXCLUDED.report_counter,
       updated_at = now()`,
    [userId, JSON.stringify(merged), newCounter]
  );

  console.log(`Restored ${recovered.length} notes for ${email}. Account now has ${merged.length} total saved reports.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
