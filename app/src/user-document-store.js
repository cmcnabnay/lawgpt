// user-document-store.js
//
// Per-account store for documents downloaded by email sync (see
// email-routes.js's /sync). Unlike document-store.js (the shared, unauthenticated
// in-memory catalog rebuilt from documents/<course>/ on disk -- Canvas imports
// and hand-placed files, visible to every visitor), these are one signed-in
// user's own attachments: downloading them into the shared documents/ folder
// and shared in-memory store would leak one user's mail attachments to every
// other user on a shared deployment (the AWS box), since that store has no
// per-user concept anywhere. Stored as a real table (not a JSONB column on
// users, unlike email_sync_state/agent_runs/doc_overrides) since rows here
// carry binary file bytes and should scale independently of the users row
// rather than rewriting one big JSON blob on every insert.
//
// Requires (run once against the Supabase app_user DB, alongside whatever
// created users/user_state -- see ~/Documents/setup-user-accounts.sql):
//
//   CREATE TABLE IF NOT EXISTS user_documents (
//     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//     title TEXT NOT NULL,
//     content_type TEXT,
//     course_id TEXT,
//     course_name TEXT,
//     file_name TEXT,
//     text TEXT,
//     file_bytes BYTEA,
//     added_at TIMESTAMPTZ NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS user_documents_user_id_idx ON user_documents(user_id);
//   GRANT SELECT, INSERT, UPDATE, DELETE ON user_documents TO app_user;

const SUPABASE_APP_DB_URL = process.env.SUPABASE_APP_DB_URL || "";
let appPool = null;
if (SUPABASE_APP_DB_URL) {
  const { Pool } = require("pg");
  appPool = new Pool({
    connectionString: SUPABASE_APP_DB_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// Shared column list, and the shape every row comes back in -- deliberately
// close to document-store.js's addDocument() shape so callers in
// email-routes.js/server.js barely need to branch on which store a document
// id came from.
function rowToDocument(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    url: null,
    contentType: row.content_type || "",
    courseId: row.course_id,
    courseName: row.course_name,
    fileName: row.file_name,
    text: row.text,
    fileBuffer: row.file_bytes || null,
    // has_file_bytes is only present on the list query below, which omits the
    // actual bytes for payload size but still needs to know whether one
    // exists, so the Documents tab can show Open/Download buttons.
    hasOriginalFile: row.file_bytes != null || Boolean(row.has_file_bytes),
    filePath: null,
    mine: true,
    addedAt: row.added_at ? new Date(row.added_at).toISOString() : new Date().toISOString()
  };
}

async function getAllForUser(userId) {
  if (!appPool || !userId) return [];
  const result = await appPool.query(
    "SELECT id, user_id, title, content_type, course_id, course_name, file_name, text, added_at, (file_bytes IS NOT NULL) AS has_file_bytes FROM user_documents WHERE user_id = $1 ORDER BY added_at DESC",
    [userId]
  );
  // file_bytes itself deliberately left out of the list query -- same
  // reasoning as document-store.js's /api/documents list endpoint stripping
  // fileBuffer, this is for a document-card list, not the byte content.
  return result.rows.map(row => ({ ...rowToDocument(row), fileBuffer: null }));
}

// Scoped to the owning user -- a caller must already know both the document
// id and the requesting user's id, so this doubles as the access check (a
// mismatched id/userId pair returns null exactly like a nonexistent one).
async function getDocument(userId, id) {
  if (!appPool || !userId || !id) return null;
  const result = await appPool.query(
    "SELECT id, user_id, title, content_type, course_id, course_name, file_name, text, file_bytes, added_at FROM user_documents WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  if (!result.rows[0]) return null;
  return rowToDocument(result.rows[0]);
}

// Used by email-routes.js's cross-sync dedupe check -- same idea as
// document-store.js's getDocumentByFilePath, but by the attachment's own
// filename within this user's own documents (there's no on-disk path here to
// key off of).
async function getDocumentByFileName(userId, fileName) {
  if (!appPool || !userId || !fileName) return null;
  const result = await appPool.query(
    "SELECT id, user_id, title, content_type, course_id, course_name, file_name, text, added_at FROM user_documents WHERE user_id = $1 AND file_name = $2 LIMIT 1",
    [userId, fileName]
  );
  if (!result.rows[0]) return null;
  return { ...rowToDocument(result.rows[0]), fileBuffer: null, hasOriginalFile: false };
}

async function addDocument(userId, document) {
  if (!appPool || !userId) return null;
  const result = await appPool.query(
    `INSERT INTO user_documents (user_id, title, content_type, course_id, course_name, file_name, text, file_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, user_id, title, content_type, course_id, course_name, file_name, text, file_bytes, added_at`,
    [
      userId,
      document.title,
      document.contentType || "",
      document.courseId || null,
      document.courseName || null,
      document.fileName || null,
      document.text || null,
      document.fileBuffer || null
    ]
  );
  return rowToDocument(result.rows[0]);
}

// Re-files a document under a different course (see server.js's
// /api/documents/:id/move) -- scoped to userId the same way getDocument is,
// so this also doubles as the ownership check.
async function updateDocument(userId, id, patch) {
  if (!appPool || !userId || !id) return null;
  const result = await appPool.query(
    `UPDATE user_documents SET course_id = $1, course_name = $2
     WHERE id = $3 AND user_id = $4
     RETURNING id, user_id, title, content_type, course_id, course_name, file_name, text, added_at, (file_bytes IS NOT NULL) AS has_file_bytes`,
    [patch.courseId, patch.courseName, id, userId]
  );
  if (!result.rows[0]) return null;
  return { ...rowToDocument(result.rows[0]), fileBuffer: null };
}

async function removeDocument(userId, id) {
  if (!appPool || !userId || !id) return false;
  const result = await appPool.query("DELETE FROM user_documents WHERE id = $1 AND user_id = $2", [id, userId]);
  return result.rowCount > 0;
}

module.exports = { getAllForUser, getDocument, getDocumentByFileName, addDocument, updateDocument, removeDocument };
