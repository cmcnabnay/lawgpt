// saved-report-store.js
//
// Per-account store for the Notes tab's saved reports -- one row per report
// in `saved_reports`, rather than the single user_state.saved_reports JSONB
// array they used to live in. With the array, every page load pulled every
// report's full body (several MB once there were 100+ reports), and every
// save overwrote all of them with whatever that browser tab held. Here the
// page load only fetches the sidebar fields (listStubs), a report's body is
// fetched when it's opened (getReport), and a save touches only the reports
// that actually changed (sync).
//
// `data` is the whole client-side report object, exactly as lawgpt.html
// builds it; title/course/class_label are copies of its fields for the
// sidebar listing, and position is its index in the sidebar's order.
//
// Requires (run once against the Supabase app_user DB):
//
//   CREATE TABLE IF NOT EXISTS saved_reports (
//     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//     id TEXT NOT NULL,
//     position INTEGER NOT NULL DEFAULT 0,
//     title TEXT NOT NULL DEFAULT '',
//     course TEXT,
//     class_label TEXT,
//     created_at TEXT,
//     data JSONB NOT NULL,
//     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//     PRIMARY KEY (user_id, id)
//   );
//   GRANT SELECT, INSERT, UPDATE, DELETE ON saved_reports TO app_user;
//   CREATE POLICY app_user_full_access ON saved_reports
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

// Sidebar fields only, in sidebar order -- what GET /api/user/state hands
// the page in place of the full reports. `stub: true` tells lawgpt.html the
// body hasn't been fetched yet.
async function listStubs(userId){
  if (!appPool || !userId) return [];
  const result = await appPool.query(
    "SELECT id, title, course, class_label, created_at FROM saved_reports WHERE user_id = $1 ORDER BY position, id",
    [userId]
  );
  return result.rows.map(r => ({
    id: r.id,
    title: r.title,
    course: r.course || "",
    classLabel: r.class_label || "",
    createdAt: r.created_at || null,
    stub: true
  }));
}

// One full report, scoped to the owning user.
async function getReport(userId, id){
  if (!appPool || !userId || !id) return null;
  const result = await appPool.query(
    "SELECT data FROM saved_reports WHERE user_id = $1 AND id = $2",
    [userId, String(id)]
  );
  return result.rows[0] ? result.rows[0].data : null;
}

// Every full report, in sidebar order -- only for Backup (an explicit,
// occasional export), never on page load.
async function getAllReports(userId){
  if (!appPool || !userId) return [];
  const result = await appPool.query(
    "SELECT data FROM saved_reports WHERE user_id = $1 ORDER BY position, id",
    [userId]
  );
  return result.rows.map(r => r.data);
}

// Applies one batch of changes from the page in a single transaction:
// `upserts` are full report objects that are new or changed, `deletes` are
// ids removed since the last sync, and `order` (if present) is the full
// list of ids in sidebar order. Writes only -- nothing is read back.
async function sync(userId, { upserts, deletes, order }){
  if (!appPool || !userId) return;
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    for (const report of upserts || []) {
      if (!report || typeof report !== "object" || !report.id) continue;
      await client.query(
        `INSERT INTO saved_reports (user_id, id, title, course, class_label, created_at, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id, id) DO UPDATE SET
           title = EXCLUDED.title,
           course = EXCLUDED.course,
           class_label = EXCLUDED.class_label,
           created_at = EXCLUDED.created_at,
           data = EXCLUDED.data,
           updated_at = now()`,
        [
          userId,
          String(report.id),
          typeof report.title === "string" ? report.title : "",
          report.course || null,
          report.classLabel || null,
          report.createdAt || null,
          JSON.stringify(report)
        ]
      );
    }
    const deleteIds = (deletes || []).map(String);
    if (deleteIds.length) {
      await client.query(
        "DELETE FROM saved_reports WHERE user_id = $1 AND id = ANY($2::text[])",
        [userId, deleteIds]
      );
    }
    if (Array.isArray(order)) {
      await client.query(
        `UPDATE saved_reports s SET position = o.ord
         FROM unnest($2::text[]) WITH ORDINALITY AS o(id, ord)
         WHERE s.user_id = $1 AND s.id = o.id`,
        [userId, order.map(String)]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listStubs, getReport, getAllReports, sync };
