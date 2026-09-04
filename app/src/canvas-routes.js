// canvas-routes.js
//
// Server-side Canvas scraper for the LawGPT "Import" tab. This runs inside
// your existing app Node server (the same one that holds the
// OpenAI key), NOT in the browser — Canvas will not honor a credentialed
// cross-origin fetch from a page served off localhost, and this also keeps
// the session cookie off of any browser storage.
//
// The cookie the browser sends here is used for exactly one outbound
// request chain (list modules -> follow each item -> download files) and is
// never written to disk or logged.
//
// Install deps in your app folder:
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
// Only requires "puppeteer" itself lazily, inside scrapeNewQuiz() -- so
// requiring this module here doesn't load Chromium/puppeteer machinery
// unless a New Quizzes scrape actually runs.
const { scrapeNewQuiz, findQuizLinksViaBrowser } = require("./canvas-new-quiz-scrape");

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
const DOCS_ROOT = path.join(__dirname, "..", "..", "documents");

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

// The filename a title maps to on disk, minus its extension -- factored out
// of saveNativeFile() so the /scrape route below can predict a Canvas item's
// eventual on-disk name from its title ALONE (before downloading anything)
// and check whether that name is already sitting in documents/<course>/,
// without duplicating this exact stripping logic in two places and having
// them drift out of sync.
function deriveBaseName(title){
  const titleExtMatch = /\.([a-z0-9]{1,8})$/i.exec(title || "");
  const titleHasKnownExt = titleExtMatch && KNOWN_EXTENSIONS.has(titleExtMatch[1].toLowerCase());
  return sanitizeForFs(titleHasKnownExt ? title.slice(0, -titleExtMatch[0].length) : title) || "document";
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
    const base = deriveBaseName(title);
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

// True if fetchRes ended up (after node-fetch's automatic redirect-follow)
// on a different origin than baseOrigin -- the one reliable, provider-
// agnostic signal that a request got bounced to a login flow instead of
// reaching the page it asked for. Works whether that's Canvas's own login
// page moved to a different host, or an institution's SSO provider
// (Microsoft/Okta/Shibboleth/etc.) entirely, without needing to know that
// provider's specific login markup.
function offCanvasOriginError(fetchRes, baseOrigin) {
  let finalOrigin = null;
  try { finalOrigin = new URL(fetchRes.url).origin; } catch { /* leave null */ }
  if (!finalOrigin || finalOrigin === baseOrigin) return null;
  return {
    error: `Canvas redirected off-site to a login page instead of the page this needed -- the session cookie isn't currently authenticated (it landed on ${finalOrigin}). Get a fresh cookie value (make sure you're actually logged into Canvas in that browser tab first) and try again.`,
    finalUrl: fetchRes.url
  };
}

function isSafeCanvasUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}

// Some Instructure-hosted Canvas instances use "_normandy_session" as their
// actual session cookie name (Canvas's Rails app internal codename) rather
// than "canvas_session" -- but canvas.uh.edu (this app's own Canvas
// instance, per DevTools) uses "canvas_session" literally, so that's the
// name a bare pasted value gets attached to. If the pasted value already
// looks like a full "name=value; name2=value2" cookie string (e.g. copied
// from the Network tab's "Cookie" request header, or from Application ->
// Cookies with multiple rows joined by hand), it's passed through as-is
// instead -- that path is unaffected by whichever name is right here, so
// it's the more robust thing to paste if this default is ever wrong again.
function buildCookieHeader(cookie) {
  return cookie.includes("=") ? cookie : `canvas_session=${cookie}`;
}

async function canvasGet(baseUrl, path, cookie) {
  const url = path.startsWith("http") ? path : baseUrl + path;
  const res = await withTimeout(
    fetch(url, {
      redirect: "follow",
      headers: {
        Cookie: buildCookieHeader(cookie),
        "User-Agent": "Mozilla/5.0 (LawGPT import tool)",
      },
    }),
    FETCH_TIMEOUT_MS
  );
  return res;
}

// Used only by the quiz-scrape route below, to start a quiz attempt (a POST
// is what Canvas's own "Take the Quiz" button does). refererUrl is set to
// the page the "form" was on, matching normal browser behavior in case
// Canvas's CSRF check looks at it.
async function canvasPost(baseUrl, path, cookie, formBody, refererUrl) {
  const url = path.startsWith("http") ? path : baseUrl + path;
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: {
        Cookie: buildCookieHeader(cookie),
        "User-Agent": "Mozilla/5.0 (LawGPT import tool)",
        "Content-Type": "application/x-www-form-urlencoded",
        ...(refererUrl ? { Referer: refererUrl } : {}),
      },
      body: formBody,
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

    // Only fetch items from Canvas that aren't already sitting in
    // documents/<courseFolderName>/ -- re-importing a course used to
    // re-download, re-extract, and re-save EVERY item on EVERY import, even
    // ones that hadn't changed since the last one. A lazy require (rather
    // than a top-of-file one) sidesteps a load-order circular dependency:
    // local-scan.js itself requires this module (for extractText/DOCS_ROOT),
    // so requiring it back at module-load time here would hand local-scan.js
    // an incomplete version of this module's exports; by request time both
    // modules are already fully loaded, so this just resolves from cache.
    const { scanLocalDocuments } = require("./local-scan");
    await scanLocalDocuments().catch(() => {}); // pick up anything dropped into documents/ by hand since the last scan
    const existingByBaseName = new Map();
    for (const doc of documentStore.getDocumentsByCourse(courseFolderName)) {
      if (doc.fileName) existingByBaseName.set(deriveBaseName(doc.fileName).toLowerCase(), doc);
    }

    const links = [];
    const seenHrefs = new Set();
    $(".context_module_item").each((_, el) => {
      const a = $(el).find("a.ig-title").first();
      const title = a.text().trim();
      const href = a.attr("href");
      if (title && href && !href.includes("{{") && !seenHrefs.has(href)) {
        seenHrefs.add(href);
        links.push({ title, href });
      }
    });

    // Not everything is organized into Modules -- e.g. an assignment's
    // instructions PDF may only be reachable from the Assignments list, with
    // no module item pointing at it. Pull that list in too and follow the
    // same "HTML page -> find the real download link" path below for each
    // assignment, deduped against what Modules already found by href (a
    // module item pointing at an assignment shows up on both pages).
    try {
      const assignmentsRes = await canvasGet(baseUrl, `/courses/${courseId}/assignments`, cookie);
      if (assignmentsRes.ok) {
        const assignmentsHtml = await assignmentsRes.text();
        const $a = cheerio.load(assignmentsHtml);
        $a("a.ig-title").each((_, el) => {
          const a = $a(el);
          const title = a.text().trim();
          const href = a.attr("href");
          if (title && href && href.includes("/assignments/") && !href.includes("{{") && !seenHrefs.has(href)) {
            seenHrefs.add(href);
            links.push({ title, href });
          }
        });
      }
    } catch (err) {
      console.warn("LawGPT: couldn't fetch Canvas assignments list:", err.message);
    }

    const items = [];
    for (const { title, href } of links.slice(0, MAX_ITEMS)) {
      const existing = existingByBaseName.get(deriveBaseName(title).toLowerCase());
      if (existing) {
        items.push({
          id: existing.id,
          title: existing.title,
          url: existing.url,
          contentType: existing.contentType,
          text: existing.text,
          courseId: existing.courseId,
          courseName: existing.courseName,
          hasOriginalFile: Boolean(existing.fileBuffer),
          hasNativeFile: Boolean(existing.filePath),
          error: null,
          alreadyImported: true
        });
        continue;
      }
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

// ---------------------------------------------------------------------------
// Quiz question scraping ("Scrape Quiz" button on a Schedule quiz card).
//
// Canvas's classic Quizzes engine only ever shows a quiz's actual question
// text and answer choices on the quiz-TAKING page, and loading that page is
// what starts a real attempt server-side -- exactly the same thing that
// happens when a student clicks "Take the Quiz" themselves. There's no
// read-only way to see the questions beforehand. This route does exactly
// that: finds the quiz, starts an attempt, and reads the resulting question
// form -- then deliberately stops. It never submits that attempt (no POST to
// a submit/finish endpoint), so it's left open/unfinished in Canvas: no
// answers are recorded and nothing gets graded on the student's behalf.
// Whether leaving an attempt open costs one of a limited attempt count is a
// property of the specific quiz's own settings, which this route can't know
// in advance -- the user was told that tradeoff explicitly and chose to
// start real attempts rather than being limited to scraping quizzes only
// after they'd already been completed.
//
// The scraped Q&A is saved as a real document (same store, and same
// documents/<course>/ location, a normal Canvas import uses), titled to
// EXACTLY match the quiz's schedule title (quizTitle) -- so the existing
// fuzzy title-match lookup the "Complete" button already runs on every click
// (lookupCanvasMatches -> findDocumentMatches, in lawgpt.html) picks it up
// automatically. No change to that flow was needed.
//
// This can't be tested against a live Canvas instance from here, so the
// selectors below are deliberately defensive (several fallbacks per element)
// and every failure mode returns a specific, actionable error message
// instead of a raw stack trace. If Canvas's actual markup doesn't match what
// this expects, the fix is almost always just adding another selector to
// try, not a rewrite.
router.post("/quiz", async (req, res) => {
  const { baseUrl, courseId, cookie, quizTitle, courseFolder } = req.body || {};

  if (!baseUrl || !courseId || !cookie || !quizTitle || !courseFolder) {
    return res.status(400).json({ error: "baseUrl, courseId, cookie, quizTitle, and courseFolder are all required." });
  }
  if (!isSafeCanvasUrl(baseUrl)) {
    return res.status(400).json({ error: "baseUrl must be a valid https:// URL." });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(String(courseId))) {
    return res.status(400).json({ error: "courseId looks malformed." });
  }

  try {
    // 1. Find the quiz on the course's Quizzes index page by title -- an
    // exact (case-insensitive) match on the link text if there is one,
    // otherwise the first link that contains/is contained by the wanted
    // title, so a small wording drift doesn't just fail outright.
    const listRes = await canvasGet(baseUrl, `/courses/${courseId}/quizzes`, cookie);
    if (listRes.status === 401 || listRes.status === 302) {
      return res.status(401).json({ error: "Canvas rejected the session cookie (expired or invalid)." });
    }
    if (!listRes.ok) {
      return res.status(502).json({ error: `Canvas returned ${listRes.status} for the quizzes list.` });
    }

    // node-fetch follows redirects automatically (canvasGet passes
    // redirect:"follow"), so an expired/invalid session cookie never shows
    // up as the 401/302 checked above -- Canvas 302s to a login flow, that
    // gets followed silently, and what lands here is just a 200 for
    // whatever login page it ended on. See offCanvasOriginError -- this
    // check (and the same one after every later fetch below) is what
    // catches that instead of silently treating a login page as real
    // content.
    const baseOrigin = new URL(baseUrl).origin;
    const listAuthErr = offCanvasOriginError(listRes, baseOrigin);
    if (listAuthErr) return res.status(401).json(listAuthErr);

    const listHtml = await listRes.text();
    const $list = cheerio.load(listHtml);

    // Canvas's OWN login page (as opposed to an off-site SSO redirect, which
    // the origin check above already caught) is still served from baseUrl's
    // origin, so it wouldn't be caught by that check -- look for it
    // directly.
    if ($list("#login_form, #pseudonym_session_unique_id").length) {
      return res.status(401).json({ error: "Canvas served a login page instead of the quizzes list -- the session cookie is missing/expired. Get a fresh one and try again." });
    }
    // "New Quizzes" (the Quizzes.Next LTI tool, which Instructure has been
    // migrating everyone to as classic Quizzes gets retired) is assignment-
    // backed rather than a classic Quiz model -- its row on this same index
    // page links to /courses/:id/assignments/:id instead of
    // /courses/:id/quizzes/:id. newQuizzesHint (scanning the raw HTML for
    // known markers, rather than relying on any one guessed selector) is
    // page-wide corroboration used below, once a specific quiz's link shape
    // is known, to decide which scraping strategy that quiz needs -- it no
    // longer bails out the whole request by itself, since a course could in
    // principle mix classic and New quizzes.
    const newQuizzesHint = /quiz[-_]lti|quizzesnext|quizzes\.next|new_quizzes|assignment_2\d{5,}/i.test(listHtml);

    // Match on href pattern rather than a guessed class name, since that's
    // far more robust to differences in Canvas's skin/version than any
    // specific class -- a classic quiz show link is /courses/:id/quizzes/:id
    // and a New Quiz's is /courses/:id/assignments/:id, both with no further
    // path segment (an edit/moderate/statistics/history link has one, and
    // #-only anchors have no numeric id at all).
    const quizHrefShape = /\/(quizzes|assignments)\/\d+\/?(\?.*)?$/;
    let allQuizLinks = $list('a[href*="/quizzes/"], a[href*="/assignments/"]')
      .filter((_, el) => quizHrefShape.test($list(el).attr("href") || ""))
      .toArray()
      .map(el => ({ text: $list(el).text().trim(), href: $list(el).attr("href") }))
      .filter(l => l.text);

    // Some Canvas skins/themes (this one included, apparently) render the
    // quizzes list itself via JavaScript -- a plain fetch then sees an empty
    // nav shell and zero links, regardless of whether any quizzes exist.
    // Falling back to a real rendered page only when the cheap path found
    // truly nothing (not just no title match) keeps the common case fast.
    let browserFallback = null;
    if (!allQuizLinks.length) {
      browserFallback = await findQuizLinksViaBrowser(listRes.url || (baseUrl + `/courses/${courseId}/quizzes`), buildCookieHeader(cookie), baseOrigin);
      if (browserFallback.error) {
        return res.status(502).json({ error: browserFallback.error, finalUrl: browserFallback.finalUrl, debugScreenshot: browserFallback.debugScreenshot });
      }
      allQuizLinks = (browserFallback.links || []).filter(l => quizHrefShape.test(l.href));
    }

    const wanted = quizTitle.trim().toLowerCase();
    let quizHref = null;
    for (const l of allQuizLinks) {
      if (l.text.toLowerCase() === wanted) { quizHref = l.href; break; }
    }
    if (!quizHref) {
      for (const l of allQuizLinks) {
        const t = l.text.toLowerCase();
        if (t.includes(wanted) || wanted.includes(t)) { quizHref = l.href; break; }
      }
    }
    if (!quizHref) {
      // Echo back exactly what titles/links WERE found (deduped, capped) so
      // a mismatch (wrong course, unpublished quiz, wording drift, or zero
      // links at all) is diagnosable from the error message alone.
      const seen = new Set();
      const foundTitles = [];
      for (const l of allQuizLinks) {
        if (seen.has(l.text)) continue;
        seen.add(l.text);
        foundTitles.push(l.text);
        if (foundTitles.length >= 30) break;
      }

      let detail;
      if (foundTitles.length) {
        detail = ` Titles found there instead: ${foundTitles.join(" | ")}`;
      } else {
        // Zero shaped links at all, even after the browser-rendered fallback
        // (if it ran) -- broaden the net (any anchor whose text or href
        // merely mentions "quiz", no path-shape requirement) and include
        // enough of the actual page for a human to eyeball, so the *next*
        // fix (if any) doesn't need another blind guess-and-check round
        // trip. Pulled from whichever source (plain fetch or rendered
        // browser page) actually ran, so this reflects what was really seen
        // rather than the plain fetch's empty shell when the fallback fired.
        let anyQuizAnchors, pageTitle, bodySnippet, diagnosticUrl;
        if (browserFallback) {
          anyQuizAnchors = (browserFallback.links || [])
            .filter(l => l.text.toLowerCase().includes("quiz") || l.href.toLowerCase().includes("quiz"))
            .slice(0, 20);
          pageTitle = null;
          bodySnippet = browserFallback.bodySnippet || "";
          diagnosticUrl = browserFallback.finalUrl;
        } else {
          anyQuizAnchors = $list("a")
            .toArray()
            .map(el => ({ text: $list(el).text().trim(), href: $list(el).attr("href") || "" }))
            .filter(l => l.text.toLowerCase().includes("quiz") || l.href.toLowerCase().includes("quiz"))
            .slice(0, 20);
          pageTitle = $list("title").first().text().trim();
          $list("script, style, noscript").remove();
          bodySnippet = $list("body").text().replace(/\s+/g, " ").trim().slice(0, 1200);
          diagnosticUrl = listRes.url;
        }

        detail = browserFallback
          ? " No quiz links were found even after rendering the page with a real browser."
          : " No quiz links were found on that page at all.";
        return res.status(404).json({
          error: `Couldn't find a quiz titled "${quizTitle}" on the quizzes page.${detail}`,
          finalUrl: diagnosticUrl,
          debugScreenshot: browserFallback ? browserFallback.debugScreenshot : null,
          pageTitle,
          anyQuizAnchors,
          bodySnippet
        });
      }
      return res.status(404).json({
        error: `Couldn't find a quiz titled "${quizTitle}" on the quizzes page.${detail}`,
        finalUrl: listRes.url,
        foundTitles
      });
    }
    const quizShowUrl = quizHref.startsWith("http") ? quizHref : baseUrl + quizHref;

    // A New Quiz's own link on this list page is assignment-shaped even if
    // the page-wide marker scan (newQuizzesHint) happened not to fire for
    // some reason -- either signal is enough to route this specific quiz
    // through the browser-automation path instead of the classic one.
    if (newQuizzesHint || /\/assignments\//.test(quizHref)) {
      const cookieHeader = buildCookieHeader(cookie);
      const result = await scrapeNewQuiz(quizShowUrl, cookieHeader, baseOrigin);

      if (result.error) {
        return res.status(502).json({ error: result.error, finalUrl: result.finalUrl, debugScreenshot: result.debugScreenshot });
      }
      if (!result.rawText) {
        return res.status(502).json({
          error: "Started the New Quizzes attempt but couldn't read any content off the rendered page -- its player's markup may differ from what this scraper expects.",
          finalUrl: result.finalUrl,
          debugScreenshot: result.debugScreenshot
        });
      }

      const lines = [];
      lines.push(`${quizTitle} — content scraped from Canvas New Quizzes on ${new Date().toLocaleString()}.`);
      lines.push("An attempt was started in Canvas to read this content, then left open/unsubmitted -- no answers were recorded or submitted.");
      lines.push("NOTE: New Quizzes renders via JavaScript, so this is the quiz player's visible page text rather than cleanly separated question/answer-choice fields the way a classic quiz's scrape is -- it may include some extra UI text (timer, navigation labels, etc.) alongside the actual questions and choices.");
      if (result.onePerPage) {
        lines.push(`NOTE: this quiz shows one question at a time -- paged through "Next" (without selecting any answer) to read all ${result.screensRead} screens below, each separated by a "----- next question -----" marker; some navigation chrome repeats on every screen.`);
      }
      lines.push("");
      lines.push(result.rawText);
      const formatted = lines.join("\n").trim() + "\n";

      const nativeFile = saveNativeFile(courseFolder, quizTitle, "txt", Buffer.from(formatted, "utf-8"));
      if (nativeFile) {
        const existing = documentStore.getDocumentByFilePath(nativeFile.filePath);
        if (existing) documentStore.removeDocument(existing.id);
      }
      const document = documentStore.addDocument({
        title: quizTitle,
        url: quizShowUrl,
        contentType: "text/plain",
        text: formatted,
        courseId: courseFolder,
        courseName: null,
        fileBuffer: null,
        fileName: nativeFile ? nativeFile.fileName : null,
        filePath: nativeFile ? nativeFile.filePath : null
      });

      return res.json({
        documentId: document.id,
        title: document.title,
        questionsCount: result.onePerPage ? result.screensRead : null,
        onePerPage: result.onePerPage,
        warning: "Scraped via New Quizzes browser automation, so this is unstructured page text rather than parsed question/choice fields" + (result.onePerPage ? ` -- paged through all ${result.screensRead} screens.` : ".")
      });
    }

    const quizIdMatch = /\/quizzes\/(\d+)/.exec(quizShowUrl);
    if (!quizIdMatch) {
      return res.status(500).json({ error: "Found the quiz link but couldn't parse a quiz ID out of its URL." });
    }
    const quizId = quizIdMatch[1];

    // 2. Load the quiz's own page: grab the CSRF token every Rails POST
    // needs, and bail out early with a clear, specific message if the quiz
    // is locked or needs an access code -- rather than starting an attempt
    // that's just going to fail anyway.
    const showRes = await canvasGet(baseUrl, quizShowUrl, cookie);
    if (!showRes.ok) {
      return res.status(502).json({ error: `Canvas returned ${showRes.status} for the quiz page.` });
    }
    const showAuthErr = offCanvasOriginError(showRes, baseOrigin);
    if (showAuthErr) return res.status(401).json(showAuthErr);
    const showHtml = await showRes.text();
    const $show = cheerio.load(showHtml);
    const csrfToken = $show('meta[name="csrf-token"]').attr("content");
    if (!csrfToken) {
      return res.status(502).json({ error: "Couldn't find a CSRF token on the quiz page -- Canvas's page structure may have changed." });
    }
    const lockText = $show(".lock_explanation, .quiz-locked, #not_available_message").first().text().replace(/\s+/g, " ").trim();
    if (lockText) {
      return res.status(409).json({ error: `This quiz isn't available yet: "${lockText}"` });
    }
    if ($show("#quiz_access_code, input[name='quiz_access_code']").length) {
      return res.status(409).json({ error: "This quiz requires an access code, which can't be entered automatically -- use Context to paste the questions in by hand instead." });
    }

    // 3. Start (or resume) the attempt and read the resulting question page.
    // This is the one request in this route that actually changes something
    // in Canvas -- see the comment above the route for what that means.
    const takeRes = await canvasPost(
      baseUrl,
      `/courses/${courseId}/quizzes/${quizId}/take`,
      cookie,
      `authenticity_token=${encodeURIComponent(csrfToken)}`,
      quizShowUrl
    );
    if (!takeRes.ok) {
      return res.status(502).json({ error: `Canvas returned ${takeRes.status} when starting the quiz attempt.` });
    }
    const takeAuthErr = offCanvasOriginError(takeRes, baseOrigin);
    if (takeAuthErr) return res.status(401).json(takeAuthErr);
    const takeHtml = await takeRes.text();
    const $take = cheerio.load(takeHtml);

    // 4. Parse questions out of the take page. Several selector fallbacks,
    // since this is scraping unversioned markup, not a documented API.
    let $questions = $take(".question_holder .question");
    if (!$questions.length) $questions = $take(".display_question");
    if (!$questions.length) $questions = $take('div[id^="question_"]');

    const questions = [];
    $questions.each((i, el) => {
      const $q = $take(el);
      const text =
        $q.find(".question_text").first().text().replace(/\s+/g, " ").trim() ||
        $q.find(".text").first().text().replace(/\s+/g, " ").trim();
      if (!text) return;

      const choices = [];
      $q.find(".answers .answer, .answer").each((_, ansEl) => {
        const $ans = $take(ansEl);
        const label =
          $ans.find(".answer_text, label").first().text().replace(/\s+/g, " ").trim() ||
          $ans.text().replace(/\s+/g, " ").trim();
        if (label && !choices.includes(label)) choices.push(label);
      });

      questions.push({ number: i + 1, text, choices });
    });

    if (!questions.length) {
      return res.status(502).json({
        error: "Started the attempt but couldn't find any questions on the page -- Canvas's markup for this quiz/instance may differ from what this scraper expects. Use Context to paste the questions in by hand instead."
      });
    }

    // Canvas's "one question at a time" mode only ever shows one question
    // per page load, revealing the next one via an AJAX "Next" click that
    // also records whatever's currently selected -- so unlike the normal
    // "everything on one page" case, this route can only ever safely read
    // the first question of a one-question-at-a-time quiz.
    const onePerPage = Boolean($take("#next_question_button, .next_question_button, button[name='next']").length);

    // 5. Format and save as a document, titled to EXACTLY match quizTitle so
    // the schedule's existing "Complete" button finds it on its own via the
    // normal fuzzy title-match lookup -- no other client-side change needed.
    const lines = [];
    lines.push(`${quizTitle} — questions scraped from Canvas on ${new Date().toLocaleString()}.`);
    lines.push(`An attempt was started in Canvas to read these questions, then left open/unsubmitted -- no answers were recorded or submitted.`);
    if (onePerPage) {
      lines.push(`NOTE: this quiz shows one question at a time, so only the first question below could be read without progressing (and recording) further answers.`);
    }
    lines.push("");
    questions.forEach(q => {
      lines.push(`Question ${q.number}: ${q.text}`);
      if (q.choices.length) {
        q.choices.forEach((c, idx) => lines.push(`  ${String.fromCharCode(97 + idx)}. ${c}`));
      }
      lines.push("");
    });
    const formatted = lines.join("\n").trim() + "\n";

    const nativeFile = saveNativeFile(courseFolder, quizTitle, "txt", Buffer.from(formatted, "utf-8"));
    if (nativeFile) {
      const existing = documentStore.getDocumentByFilePath(nativeFile.filePath);
      if (existing) documentStore.removeDocument(existing.id);
    }
    const document = documentStore.addDocument({
      title: quizTitle,
      url: quizShowUrl,
      contentType: "text/plain",
      text: formatted,
      courseId: courseFolder,
      courseName: null,
      fileBuffer: null,
      fileName: nativeFile ? nativeFile.fileName : null,
      filePath: nativeFile ? nativeFile.filePath : null
    });

    return res.json({
      documentId: document.id,
      title: document.title,
      questionsCount: questions.length,
      onePerPage,
      warning: onePerPage ? "Only the first question could be read (this quiz shows one question at a time)." : null
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Quiz scrape failed." });
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