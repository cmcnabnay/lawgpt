// canvas-routes.js
//
// Server-side Canvas scraper for the LawGPT "Import" tab. This runs inside
// your existing lawgpt-proxy Node server (the same one that holds the
// OpenAI key), NOT in the browser — Canvas will not honor a credentialed
// cross-origin fetch from a page served off localhost, and this also keeps
// the session cookie off of any browser storage.
//
// The cookie the browser sends here is used for exactly one outbound
// request chain (list modules -> follow each item -> download files) and is
// never written to disk or logged.
//
// Install deps in your lawgpt-proxy folder:
//   npm install node-fetch@2 cheerio pdf-parse mammoth
//
// Then in server.js:
//   const canvasRoutes = require("./canvas-routes");
//   app.use("/api/canvas", canvasRoutes);

const express = require("express");
const fetch = require("node-fetch"); // v2 (CommonJS)
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const router = express.Router();
const documentStore = require("./document-store");

const MAX_ITEMS = 60;           // safety cap per course
const MAX_TEXT_CHARS = 200000;  // cap extracted text per file before returning it
const FETCH_TIMEOUT_MS = 20000;
const MAX_STORED_PDF_BYTES = 20 * 1024 * 1024; // cap on keeping the raw PDF around for direct upload to OpenAI

// Every file pulled in from Canvas is written to disk here, in its native
// (unmodified) format, under a per-course subfolder — e.g.
// documents/Civil Procedure/Winter v NRDC.pdf — so the material is still
// there after the proxy restarts and can be opened directly (e.g. in the
// Draft & Compile editor) rather than only living as extracted text in the
// in-memory document store.
const DOCS_ROOT = path.join(__dirname, "..", "documents");

// Maps a content-type (or, failing that, the title's own extension) to the
// file extension used when saving the native file to disk.
const EXT_BY_CONTENT_TYPE = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "text/html": "html",
  "text/plain": "txt",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif"
};

// Extensions this app actually recognizes -- the value side of
// EXT_BY_CONTENT_TYPE above. Used to keep a trailing "." in a hand-typed
// title (e.g. "Exercise 3.2.1", "R2 §§1, 2, 4") from being misread as a
// real extension just because what follows the last "." happens to be
// short and alphanumeric -- "1" or "4" pass that test as easily as "pdf"
// does, which would wrongly chop a title like "Exercise 3.2.1" down to
// "Exercise 3.2".
const KNOWN_EXTENSIONS = new Set(Object.values(EXT_BY_CONTENT_TYPE));

function extFromContentTypeOrTitle(contentType, title){
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_CONTENT_TYPE[type]) return EXT_BY_CONTENT_TYPE[type];
  const m = /\.([a-z0-9]{1,8})$/i.exec(title || "");
  const ext = m ? m[1].toLowerCase() : "";
  return KNOWN_EXTENSIONS.has(ext) ? ext : "bin";
}

// Canvas course names come through as long, semester-stamped titles (e.g.
// "2026FA LAW5406 10692 - Civil Procedure"), but documents/ has been
// reorganized to use short, stable slugs instead. Match on a keyword in the
// scraped name so re-imports keep landing in the folder the user actually
// renamed things to, rather than recreating the old long-form folder.
const COURSE_FOLDER_ALIASES = [
  { match: /civil procedure/i, folder: "civil_procedure" },
  { match: /lawyering skills/i, folder: "lawyering_skills_and_strategies" },
  { match: /contracts/i, folder: "contracts" },
  { match: /torts/i, folder: "torts" },
];

// Runs COURSE_FOLDER_ALIASES against an arbitrary string (a Canvas course
// name, or -- for email-routes.js -- an email's subject+body) and returns
// the matched folder slug, or null if nothing matched. Factored out of
// resolveCourseFolderName so callers that don't want its "fall back to a
// sanitized course name" behavior (email import has no course name to fall
// back to) can use the same matching logic directly.
function matchCourseFolder(text){
  for (const { match, folder } of COURSE_FOLDER_ALIASES){
    if (match.test(text || "")) return folder;
  }
  return null;
}

function resolveCourseFolderName(courseName, courseId){
  const matched = matchCourseFolder(courseName);
  if (matched) return matched;
  return sanitizeForFs(courseName || `Course ${courseId}`) || `Course ${courseId}`;
}

// Strips characters that are unsafe/awkward in filenames or folder names on
// most filesystems, and caps the length so titles pulled from Canvas (which
// can be long) don't blow past filesystem limits.
function sanitizeForFs(str){
  return String(str || "")
    .replace(/[\/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// Writes `buffer` to disk under documents/<courseFolder>/<title>.<ext>,
// overwriting any existing file of the same name (re-importing a course is
// treated as refreshing its materials, not accumulating duplicates).
// Returns the native filename and its path relative to DOCS_ROOT, or null if
// the write failed (permissions, disk full, etc.) — callers fall back to
// keeping the document in-memory-only in that case.
function saveNativeFile(courseFolder, title, ext, buffer){
  try {
    const dir = path.join(DOCS_ROOT, courseFolder);
    fs.mkdirSync(dir, { recursive: true });
    const titleExtMatch = /\.([a-z0-9]{1,8})$/i.exec(title || "");
    const titleHasKnownExt = titleExtMatch && KNOWN_EXTENSIONS.has(titleExtMatch[1].toLowerCase());
    const base = sanitizeForFs(titleHasKnownExt ? title.slice(0, -titleExtMatch[0].length) : title) || "document";
    const fileName = `${base}.${ext}`;
    fs.writeFileSync(path.join(dir, fileName), buffer);
    return { fileName, filePath: path.join(courseFolder, fileName) };
  } catch (err) {
    console.warn("LawGPT: couldn't save native file to disk:", err.message);
    return null;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

function isSafeCanvasUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}

async function canvasGet(baseUrl, path, cookie) {
  const url = path.startsWith("http") ? path : baseUrl + path;
  const res = await withTimeout(
    fetch(url, {
      redirect: "follow",
      headers: {
        Cookie: `canvas_session=${cookie}`,
        "User-Agent": "Mozilla/5.0 (LawGPT import tool)",
      },
    }),
    FETCH_TIMEOUT_MS
  );
  return res;
}

async function extractText(buffer, contentType, filename) {
  const type = (contentType || "").toLowerCase();
  const lower = (filename || "").toLowerCase();

  try {
    if (type.includes("text/plain") || lower.endsWith(".txt")) {
      return buffer.toString("utf-8").slice(0, MAX_TEXT_CHARS);
    }
    if (type.includes("text/html") || lower.endsWith(".html") || lower.endsWith(".htm")) {
      const $ = cheerio.load(buffer.toString("utf-8"));
      $("script,style").remove();
      return $("body").text().replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
    }
    if (type.includes("application/pdf") || lower.endsWith(".pdf")) {
      // pdf-parse rewrote its API in v2: v1 exported a plain function
      // (`pdf(buffer)`), v2 exports a `PDFParse` class
      // (`new PDFParse({ data: buffer }).getText()`). Support both, plus a
      // couple of other shapes some intermediate/forked versions have used,
      // so this keeps working regardless of which version is installed.
      const pdfModule = require("pdf-parse");

      // v2 shape — `const { PDFParse } = require('pdf-parse')`. Checked
      // first since this is the current API as of pdf-parse 2.x.
      const PDFParseClass =
        (pdfModule && typeof pdfModule.PDFParse === "function" && pdfModule.PDFParse) ||
        (pdfModule && pdfModule.default && typeof pdfModule.default.PDFParse === "function" && pdfModule.default.PDFParse) ||
        null;
      if (PDFParseClass) {
        const parser = new PDFParseClass({ data: buffer });
        try {
          const result = await parser.getText();
          return (result.text || "").slice(0, MAX_TEXT_CHARS);
        } finally {
          if (typeof parser.destroy === "function") {
            try { await parser.destroy(); } catch { /* ignore cleanup errors */ }
          }
        }
      }

      // v1 shape — `const pdf = require('pdf-parse'); pdf(buffer)`.
      const pdfFn =
        (typeof pdfModule === "function" && pdfModule) ||
        (pdfModule && typeof pdfModule.default === "function" && pdfModule.default) ||
        (pdfModule && typeof pdfModule.pdf === "function" && pdfModule.pdf) ||
        null;
      if (pdfFn) {
        const data = await pdfFn(buffer);
        return (data.text || "").slice(0, MAX_TEXT_CHARS);
      }

      const seenKeys = pdfModule && typeof pdfModule === "object" ? Object.keys(pdfModule).join(", ") : typeof pdfModule;
      return { __error: `pdf-parse is installed but its exports didn't match a known shape (got: ${seenKeys}) — check \`npm ls pdf-parse\`.` };
    }
    if (
      type.includes("officedocument.wordprocessingml") ||
      lower.endsWith(".docx")
    ) {
      const mammoth = require("mammoth");
      const { value } = await mammoth.extractRawText({ buffer });
      return (value || "").slice(0, MAX_TEXT_CHARS);
    }
  } catch (err) {
    return { __error: `Couldn't extract text (${err.message})` };
  }
  return null; // unsupported type — list it, but no text
}

router.post("/scrape", async (req, res) => {
  const { baseUrl, courseId, cookie } = req.body || {};

  if (!baseUrl || !courseId || !cookie) {
    return res.status(400).json({ error: "baseUrl, courseId, and cookie are all required." });
  }
  if (!isSafeCanvasUrl(baseUrl)) {
    return res.status(400).json({ error: "baseUrl must be a valid https:// URL." });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(String(courseId))) {
    return res.status(400).json({ error: "courseId looks malformed." });
  }

  try {
    const modulesRes = await canvasGet(baseUrl, `/courses/${courseId}/modules`, cookie);
    if (modulesRes.status === 401 || modulesRes.status === 302) {
      return res.status(401).json({ error: "Canvas rejected the session cookie (expired or invalid)." });
    }
    if (!modulesRes.ok) {
      return res.status(502).json({ error: `Canvas returned ${modulesRes.status} for the modules page.` });
    }

    const modulesHtml = await modulesRes.text();
    const $ = cheerio.load(modulesHtml);

    // Best-effort course name, used to name the per-course folder under
    // documents/ and to label documents in the UI. Falls back to
    // "Course <id>" below if nothing usable is found here.
    let courseName = null;
    const titleText = $("title").first().text().trim();
    if (titleText) {
      const parts = titleText.split(":").map(s => s.trim()).filter(Boolean);
      courseName = parts.length > 1 ? parts[parts.length - 1] : (parts[0] || null);
    }
    if (!courseName) {
      const crumb = $("#crumb_courses, .ic-app-crumbs li a").last().text().trim();
      if (crumb) courseName = crumb;
    }
    const courseFolderName = resolveCourseFolderName(courseName, courseId);

    const links = [];
    $(".context_module_item").each((_, el) => {
      const a = $(el).find("a.ig-title").first();
      const title = a.text().trim();
      const href = a.attr("href");
      if (title && href && !href.includes("{{")) {
        links.push({ title, href });
      }
    });

    const items = [];
    for (const { title, href } of links.slice(0, MAX_ITEMS)) {
      const itemUrl = href.startsWith("http") ? href : baseUrl + href;
      try {
        const itemRes = await canvasGet(baseUrl, itemUrl, cookie);
        const itemContentType = itemRes.headers.get("content-type") || "";
        const finalUrl = itemRes.url || itemUrl;

        let fileRes = null;
        if (finalUrl.includes("/files/") && !itemContentType.includes("text/html")) {
          // Direct file download.
          fileRes = itemRes;
        } else {
          // HTML preview page — look for the real download link.
          const itemHtml = await itemRes.text();
          const $$ = cheerio.load(itemHtml);
          const dlHref = $$("a.file_download_btn, a[href*='/download']").first().attr("href");
          if (dlHref) {
            const dlUrl = dlHref.startsWith("http") ? dlHref : baseUrl + dlHref;
            fileRes = await canvasGet(baseUrl, dlUrl, cookie);
          }
        }

        if (!fileRes || !fileRes.ok) {
          items.push({ title, url: finalUrl, contentType: itemContentType || "page", text: null, error: fileRes ? null : "No downloadable file found" });
          continue;
        }

        const contentType = fileRes.headers.get("content-type") || "";
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        const extracted = await extractText(buffer, contentType, title);
        const extractError = (extracted && typeof extracted === "object" && extracted.__error) ? extracted.__error : null;

        const isPdf = /application\/pdf/i.test(contentType) || /\.pdf$/i.test(title);

        // Keep the raw PDF bytes around in memory too (not just the
        // extracted text), so this document can later be sent to OpenAI as
        // an actual file — avoiding the MAX_TEXT_CHARS truncation above and
        // letting the model read scanned/image content via vision. Only
        // PDFs are kept this way, and only up to a size cap.
        const fileBuffer = isPdf && buffer.length <= MAX_STORED_PDF_BYTES ? buffer : null;

        // Always save the file to disk in its native (unmodified) format,
        // regardless of whether text extraction succeeded — a document
        // LawGPT can't parse for text is still worth having the real file
        // for (e.g. to open directly, or read manually).
        const ext = extFromContentTypeOrTitle(contentType, title);
        const nativeFile = saveNativeFile(courseFolderName, title, ext, buffer);

        // Re-importing a file that's already indexed (by a prior import, or
        // by local-scan picking it up off disk first) would otherwise leave
        // a stale duplicate entry behind under the same filePath — replace
        // it instead of piling on, same "one entry per file on disk"
        // invariant local-scan.js keeps.
        if (nativeFile) {
          const existing = documentStore.getDocumentByFilePath(nativeFile.filePath);
          if (existing) documentStore.removeDocument(existing.id);
        }

        const document = documentStore.addDocument({
          title,
          url: finalUrl,
          contentType,
          text: extractError ? null : (extracted || null),
          // Use the same resolved folder slug local-scan.js and the
          // Schedule tab's SCHEDULE_COURSE_TO_FOLDER mapping key off of
          // (see lawgpt.html), not the raw numeric Canvas course id --
          // otherwise a Canvas-imported document ends up in a different
          // Documents-tab group than the same course's locally-scanned
          // files, and never matches a Schedule reading's course filter.
          courseId: courseFolderName,
          courseName: courseName || null,
          fileBuffer,
          fileName: nativeFile ? nativeFile.fileName : null,
          filePath: nativeFile ? nativeFile.filePath : null
        });

        items.push({
          id: document.id,
          title: document.title,
          url: document.url,
          contentType: document.contentType,
          text: document.text,
          courseId: document.courseId,
          courseName: document.courseName,
          hasOriginalFile: Boolean(document.fileBuffer),
          hasNativeFile: Boolean(document.filePath),
          error: extractError
        });
      } catch (err) {
        items.push({ title, url: itemUrl, contentType: null, text: null, error: err.message });
      }
    }

    return res.json({ items });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Scrape failed." });
  }
});

// Document-type extensions only -- deliberately excludes the image types
// also listed in EXT_BY_CONTENT_TYPE (jpg/png/gif), which exist there for
// Canvas file downloads but would otherwise cause email-routes.js to save
// every signature logo or tracking pixel as a "document".
const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "ods", "txt", "html"
]);

function isDocumentAttachment(filename, contentType){
  const ext = extFromContentTypeOrTitle(contentType, filename);
  return DOCUMENT_EXTENSIONS.has(ext);
}

module.exports = router;
// Attached so server.js can reuse the same PDF/HTML/docx/txt text extractor
// for the editor's generic "open a PDF" flow, without duplicating it.
module.exports.extractText = extractText;
module.exports.DOCS_ROOT = DOCS_ROOT;
// Attached so email-routes.js can reuse the same "save the native file to
// disk under documents/<course>/" logic, course-folder matching, and
// document-vs-image attachment filter that Canvas import uses, instead of
// duplicating them.
module.exports.saveNativeFile = saveNativeFile;
module.exports.matchCourseFolder = matchCourseFolder;
module.exports.isDocumentAttachment = isDocumentAttachment;
module.exports.extFromContentTypeOrTitle = extFromContentTypeOrTitle;