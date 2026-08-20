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

async function scanLocalDocuments() {
  let added = 0;

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

      const ext = (path.extname(fileName) || "").slice(1).toLowerCase();
      const title = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
      const contentType = contentTypeFromExt(ext);
      const fullPath = path.join(courseFullPath, fileName);

      let buffer;
      try {
        buffer = fs.readFileSync(fullPath);
      } catch (err) {
        console.warn(`LawGPT: couldn't read local document ${filePath}:`, err.message);
        continue;
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
