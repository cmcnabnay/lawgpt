// local-scan.js
//
// Indexes files that are already sitting in documents/<course>/ on disk —
// e.g. casebook excerpts the user downloaded by hand — into the same
// in-memory document-store the Canvas importer populates, so the Documents
// tab and the Schedule tab's "Notes" button can find them without ever
// hitting Canvas. Safe to call repeatedly (on server startup, and again on
// demand via the Documents tab's Refresh button): anything already indexed
// (matched by its path relative to documents/) is skipped.

const fs = require("fs");
const path = require("path");

const documentStore = require("./document-store");
const { extractText, DOCS_ROOT } = require("./canvas-routes");

const MAX_STORED_PDF_BYTES = 20 * 1024 * 1024; // same cap canvas-routes.js uses

const EXT_TO_CONTENT_TYPE = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html"
};

function contentTypeFromExt(ext) {
  return EXT_TO_CONTENT_TYPE[ext] || "application/octet-stream";
}

// Casebook excerpts saved by hand (e.g. "104-05", named after the page
// range rather than given a .txt extension) have no extension for
// contentTypeFromExt to key off of, so they'd otherwise fall through to
// application/octet-stream and get skipped by extractText entirely — stored
// with 0 characters of text. Sniff the actual bytes in that case: no NUL
// byte and clean UTF-8 decoding is enough to tell a text file from a real
// binary (PDF, docx, etc.).
function looksLikeText(buffer) {
  const sample = buffer.length > 8000 ? buffer.subarray(0, 8000) : buffer;
  if (!sample.length || sample.includes(0)) return false;
  const decoded = sample.toString("utf8");
  let replacements = 0;
  for (const ch of decoded) if (ch === "�") replacements++;
  return replacements / decoded.length < 0.01;
}

// path.extname() treats whatever follows the LAST "." as the extension no
// matter what it looks like, which mis-parses hand-named files like
// "CB pp. 45-125" (no real extension, just an abbreviation ending in a
// period) — it would read "45-125" as the "extension" and chop the title
// down to "CB pp". A whitelist of known extensions (rather than "any short
// alphanumeric token") is what actually fixes this: a page-range suffix
// like that fails the hyphen test either way, but so would something like
// "Exercise 3.2.1" (no real extension) under a looser [a-z0-9]{1,8} rule —
// the "1" after the last "." looks exactly like a valid 1-character
// extension, and would wrongly chop the title down to "Exercise 3.2".
// Matching only extensions we actually know how to handle (the keys of
// EXT_TO_CONTENT_TYPE) means a citation or exercise number that happens to
// end the filename is never mistaken for one.
function extFromFileName(fileName) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(fileName || "");
  const ext = m ? m[1].toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(EXT_TO_CONTENT_TYPE, ext) ? ext : "";
}

async function scanLocalDocuments() {
  let added = 0;

  // Drop any previously indexed document (from an earlier scan, or a Canvas
  // import) whose backing file no longer exists at that path — e.g. it was
  // renamed or deleted by hand since the last scan. Without this, a rename
  // leaves the old title/text behind forever as a "ghost" entry that only a
  // full server restart would clear, and even then only once the ghost's
  // own file path stops matching anything on disk (which a rename already
  // guarantees, but the in-memory store never re-checks on its own).
  for (const doc of documentStore.getAllDocuments()) {
    if (!doc.filePath) continue;
    if (!fs.existsSync(path.join(DOCS_ROOT, doc.filePath))) {
      documentStore.removeDocument(doc.id);
    }
  }

  if (!fs.existsSync(DOCS_ROOT)) return added;

  const courseFolders = fs
    .readdirSync(DOCS_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const courseDir of courseFolders) {
    const courseName = courseDir.name;
    const courseFullPath = path.join(DOCS_ROOT, courseName);

    const files = fs
      .readdirSync(courseFullPath, { withFileTypes: true })
      .filter(d => d.isFile() && !d.name.startsWith("."));

    for (const fileEnt of files) {
      const fileName = fileEnt.name;
      const filePath = path.join(courseName, fileName);

      if (documentStore.getDocumentByFilePath(filePath)) continue; // already indexed

      const ext = extFromFileName(fileName);
      const title = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
      let contentType = contentTypeFromExt(ext);
      const fullPath = path.join(courseFullPath, fileName);

      let buffer;
      try {
        buffer = fs.readFileSync(fullPath);
      } catch (err) {
        console.warn(`LawGPT: couldn't read local document ${filePath}:`, err.message);
        continue;
      }

      if (contentType === "application/octet-stream" && looksLikeText(buffer)) {
        contentType = "text/plain";
      }

      const extracted = await extractText(buffer, contentType, fileName);
      const text = extracted && typeof extracted === "object" && extracted.__error
        ? null
        : (extracted || null);

      const isPdf = ext === "pdf";
      const fileBuffer = isPdf && buffer.length <= MAX_STORED_PDF_BYTES ? buffer : null;

      documentStore.addDocument({
        title,
        url: null,
        contentType,
        text,
        courseId: courseName,
        courseName,
        fileBuffer,
        fileName,
        filePath
      });

      added++;
    }
  }

  return added;
}

module.exports = { scanLocalDocuments };
