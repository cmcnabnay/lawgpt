// email-routes.js
//
// Syncs a configurable folder (see EMAIL_FOLDER / Settings) of a personal
// mailbox that the user has set up to auto-forward their school email into,
// and downloads any course document
// attachments into documents/<course>/ (reusing the exact same
// save/extract/index pipeline canvas-routes.js uses for Canvas imports).
//
// Talks to Microsoft Graph's REST API rather than IMAP -- IMAP with a plain
// app password turned out to be rejected outright by this account
// ("AUTHENTICATE failed. Provided authentication mechanism is not
// supported."), because Microsoft now requires OAuth2 for IMAP too, not
// just basic-auth passwords. Graph sidesteps that: it's plain HTTPS with a
// bearer token. See email-auth.js for how that token is obtained/cached
// (per signed-in account -- each user connects their own mailbox), and
// server.js's /api/email-setup/start for the one-time interactive sign-in.
//
// Every route below requires a signed-in session (requireLogin) and scopes
// everything -- token, synced messages, delta watermarks, plans -- to
// req.session.userId. This route only ever calls email-auth.js's
// getAccessTokenSilent() -- never anything interactive -- so a request here
// can't hang waiting on a login. If there's no cached, refreshable token
// yet, it responds with a clear "connect your mailbox in Settings" error
// instead.
//
// Downloaded attachment files themselves are the one part of this that's
// NOT per-user: they're saved into the same shared documents/<course>/
// corpus and documentStore that Canvas imports already use, since that
// store has no per-user concept anywhere else in the app and partitioning
// it would be a much larger, separate change.

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const documentStore = require("./document-store");
const userDocumentStore = require("./user-document-store");
const emailStore = require("./email-store");
const calendarStore = require("./calendar-store");
const { extractCalendarEventsForMessage } = require("./calendar-extract");
const { unwrapLinksInText } = require("./email-links");
const { attachmentLinksText } = require("./attachment-links");
const canvasRoutes = require("./canvas-routes");
const { extractText, DOCS_ROOT, isDocumentAttachment, deriveBaseName } = canvasRoutes;
const { getAccessTokenSilent, getEmailConfig, getPersonalApiKey } = require("./email-auth");
const agentStore = require("./agent-store");
const agentRuntime = require("./agent-runtime");

// Mailbox connections and synced messages are per-account now -- there's no
// meaningful "email" anything for a request with no signed-in user.
function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: { message: "Not signed in." } });
  }
  next();
}
router.use(requireLogin);

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const MAX_STORED_PDF_BYTES = 20 * 1024 * 1024; // same cap canvas-routes.js uses
const MESSAGE_FIELDS = "subject,from,toRecipients,receivedDateTime,hasAttachments,body";

// The lawgpt project root (two levels up from app/src/) -- the directory the
// "send to agent" feature below runs the Claude Code CLI from, so it can
// read documents/<course>/ and notes/<course>/ as context. It's told not to
// write deliverable files anywhere in this repo (see agentPrompt below) --
// the whole point of running headless is that its printed response is what
// gets captured into the run's stored output (see agent-runtime.js) and
// shown/saved in the Agent tab, so that's where a deliverable belongs
// instead of a loose file under version control.
const REPO_ROOT = path.join(__dirname, "..", "..");

// Key emailStore's deltaLinks under -- see email-store.js's header comment
// for why it's an object keyed per source folder rather than one value.
// Only the "Forwarded" folder is actually synced today (see /sync below).
const FOLDER_KEY = "forwarded";

// Same OpenAI Responses API that server.js's /api/chat proxies to, using
// the signed-in user's own saved key (getPersonalApiKey) -- same per-account
// lookup /api/chat uses, so Generate Plan works with whatever key that user
// has saved in Settings, not some separate/global key.
const OPENAI_URL = "https://api.openai.com/v1/responses";
const PLAN_MODEL = "gpt-4o-mini";

// Mirrors the extractText() helper in lawgpt.html that reads an OpenAI
// Responses API result -- duplicated rather than shared since one runs in
// the browser and this runs in Node.
function extractOpenAIText(data){
  if (typeof data.output_text === "string" && data.output_text.length) return data.output_text;
  let text = "";
  if (Array.isArray(data.output)){
    for (const item of data.output){
      if (item.type === "message" && Array.isArray(item.content)){
        for (const c of item.content){
          if ((c.type === "output_text" || c.type === "text") && c.text) text += c.text;
        }
      }
    }
  }
  return text;
}

// Attachments downloaded from the email (e.g. the actual practice-problem
// PDF) usually carry the real assignment instructions, where the email body
// itself is often just "see attached, due Friday" -- so plan generation
// leans on them heavily, each capped well below the per-document
// MAX_TEXT_CHARS cap in canvas-routes.js to keep the prompt small.
const MAX_ATTACHMENT_CHARS_FOR_PLAN = 8000;

// Stored per message at sync time and sent in full to plan generation --
// capped generously rather than the old 300-char preview, which could cut
// off exactly the assignment specifics (due date, what to read) a longer
// email buries past the first couple sentences.
const MAX_BODY_CHARS = 8000;

// Attachment ids can live in either the shared documentStore (Canvas imports,
// files already on disk) or, for one this account downloaded itself via email
// sync, this user's own per-account userDocumentStore -- see the /sync loop
// below for which one a given attachment actually lands in.
async function gatherAttachmentTextForPlan(message, userId){
  const docs = await Promise.all(
    (message.documentIds || []).map(async id => {
      return documentStore.getDocument(id) || (userId ? await userDocumentStore.getDocument(userId, id) : null);
    })
  );
  return docs
    .filter(doc => doc && doc.text)
    .map(doc => `ATTACHMENT: ${doc.fileName || doc.title}\n\n${doc.text.slice(0, MAX_ATTACHMENT_CHARS_FOR_PLAN)}`)
    .join("\n\n---\n\n");
}

const PLAN_DEVELOPER_TEXT =
  "You are drafting a short, concrete task plan for an autonomous coding agent (Claude Code) that will be run " +
  "unattended, with read-only access to a law student's course-notes repository (organized as documents/<course>/ " +
  "for source material and notes/<course>/ for the student's own hand-written notes, both usable as context but " +
  "never to be created or edited). " +
  "The user explicitly asked for a plan for the email below, so always produce one -- never refuse or say there's " +
  "nothing to do. Write a numbered checklist of concrete, actionable steps the agent should take -- naming the " +
  "specific reading/case/problem and what deliverable to produce (e.g. a case brief, a written answer, an " +
  "outline, a summary of event details). The agent runs headless with no file access for its output: whatever " +
  "the plan calls for gets written directly into the agent's final response text, not saved to a file anywhere -- " +
  "so never include a step telling it to save/write a file to any path. " +
  "Base every step strictly on what the email and any attachment text below actually say -- never invent a " +
  "professor's name, case, reading, or deliverable that isn't actually named in them. If the email doesn't " +
  "describe a concrete assignment or deliverable, the plan should say so as its first step (e.g. \"Re-read the " +
  "email -- it doesn't appear to require a deliverable\") and, if there's anything else in it worth noting (a " +
  "date, a link, an event), make a later step out of that instead of inventing coursework that isn't there. " +
  "Do not include generic advice or disclaimers. Keep it under 10 steps. Output only the numbered list, nothing else.";

async function buildPlanContext(message, userId){
  const attachmentText = await gatherAttachmentTextForPlan(message, userId);
  return [
    `Subject: ${message.subject}`,
    `From: ${message.from}`,
    message.date ? `Received: ${message.date}` : "",
    `Full email body:\n${message.body || ""}`,
    attachmentText ? `Downloaded attachment text:\n\n${attachmentText}` : "(No attachments were downloaded from this email.)"
  ].filter(Boolean).join("\n\n");
}

async function generatePlanText(message, userId){
  const personalApiKey = await getPersonalApiKey(userId);
  if (!personalApiKey) {
    throw new Error("No OpenAI API key saved to your account yet -- open Settings and paste one in.");
  }

  const openaiRes = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + personalApiKey },
    body: JSON.stringify({
      model: PLAN_MODEL,
      input: [
        { role: "developer", content: [{ type: "input_text", text: PLAN_DEVELOPER_TEXT }] },
        { role: "user", content: [{ type: "input_text", text: await buildPlanContext(message, userId) }] }
      ]
    })
  });
  const data = await openaiRes.json().catch(() => null);
  if (!openaiRes.ok) {
    throw new Error((data && data.error && data.error.message) || `OpenAI returned ${openaiRes.status}`);
  }
  const text = extractOpenAIText(data || {}).trim();
  if (!text) throw new Error("OpenAI returned an empty plan.");
  return text;
}

// Used by the Email tab's "Generate plan" / "Regenerate plan" button --
// never called automatically at sync time (see /sync below). Never throws --
// a failure is stored as planError so the UI can show it and offer a retry,
// instead of the button click erroring out.
async function generateAndStorePlan(userId, id){
  const message = await emailStore.getMessage(userId, id);
  if (!message) return null;
  try {
    const text = await generatePlanText(message, userId);
    return await emailStore.updateMessage(userId, id, { plan: text, planError: null, planGeneratedAt: new Date().toISOString() });
  } catch (err) {
    return await emailStore.updateMessage(userId, id, { planError: err.message || "Plan generation failed." });
  }
}

// "Send to agent" used to open a real, visible terminal running Claude Code
// on whatever machine the server process happened to be on -- that only
// ever worked when the server was running on the same desktop machine as
// the browser, and fails outright on a headless box like EC2 (nowhere for a
// terminal to appear). It now runs the Claude Code CLI headlessly instead
// (agent-runtime.js spawns `claude -p` as a plain background process, no
// display needed) and streams its output into the Agent tab instead of a
// terminal window -- see agent-runtime.js/agent-store.js for the run
// lifecycle and agent-routes.js for how the Agent tab polls it.

// Outlook's junk-mail filtering runs before inbox rules do, so a message
// that should have been moved into the Forwarded folder by the user's rule
// can get diverted into Junk Email first and never reach that rule at all
// -- Outlook.com's own Safe-senders-list feature is meant to prevent this,
// but has been unreliable (repeatedly failing to save, even after a full
// reboot). Rather than depend on that, the Junk Email folder is synced too
// (see JUNK_FOLDER_KEY below), restricted to this sender-domain check so
// actual junk mail from everyone else doesn't get imported as if it were
// course material.
const UH_SENDER_DOMAIN = /(^|\.)uh\.edu$/i;

function isFromUhDomain(msg){
  const address = (msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || "";
  const domain = address.split("@")[1] || "";
  return UH_SENDER_DOMAIN.test(domain);
}

// An email's course comes only from who sent it and who it was sent to --
// never from words in its subject/body. A body-text match used to be the
// last fallback, and a newsletter listing several unrelated events got filed
// under Torts (and every event in it colored Torts) just because one news
// blurb mentioned the "Professor Joseph Sanders Endowed Professorship for
// Torts". Anything matching neither list below stays "uncategorized".
const COURSE_RECIPIENT_ADDRESSES = {
  civil_procedure: ["C_Law_Class_F26-LANHAM-Procedure@Central.UH.EDU"],
  torts: ["C_Law_Class_F26-SANDERS-Torts@Central.UH.EDU"],
  contracts: ["C_Law_Class_F26-BUSH-Contracts-B1@Central.UH.EDU"],
  lawyering_skills_and_strategies: ["hatruske@Central.UH.EDU"],
};

const COURSE_SENDER_ADDRESSES = {
  civil_procedure: [
    "sawill35@CougarNet.UH.EDU",
    "ajlanham@Central.UH.EDU",
    "msong23@CougarNet.UH.EDU",
    "egoneill@CougarNet.UH.EDU",
    "attrevi4@CougarNet.UH.EDU",
  ],
  torts: ["arkrasin@CougarNet.UH.EDU", "JSanders@Central.UH.edu"],
  contracts: ["ddbush@Central.UH.EDU", "mhleung@CougarNet.UH.EDU"],
  lawyering_skills_and_strategies: ["hatruske@Central.UH.EDU"],
};

// Canvas notifications all come from the same address, so they only count
// for a course when the subject names that course's Canvas section.
const CANVAS_NOTIFICATION_SENDER = "notifications@instructure.com";
const CANVAS_SUBJECT_COURSES = [
  { subject: "2026FA LAW5314 12469 - Lawyering Skills and Strategies I", folder: "lawyering_skills_and_strategies" },
];

const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function extractAddresses(text){
  return (String(text || "").match(EMAIL_ADDRESS_PATTERN) || []).map(a => a.toLowerCase());
}

// Header lines ("From:", "To:", ...) of any forwarded message quoted in the
// body -- mail synced from the "Forwarded" folder often shows the forwarder
// as the sender/recipient, with the original ones only in these lines.
function forwardedHeaderLines(body, header){
  const pattern = new RegExp(`^\\s*${header}:`, "i");
  return String(body || "").split(/\r?\n/).filter(line => pattern.test(line)).join("\n");
}

function matchAddressTable(addresses, table){
  for (const [folder, list] of Object.entries(table)){
    if (list.some(a => addresses.includes(a.toLowerCase()))) return folder;
  }
  return null;
}

// Plain lowercase address list from Graph's toRecipients (the shape stored
// on each message as `toAddresses`, so later reclassification doesn't need
// to re-fetch it).
function recipientAddresses(toRecipients){
  return (toRecipients || [])
    .map(r => ((r && r.emailAddress && r.emailAddress.address) || "").toLowerCase())
    .filter(Boolean);
}

function matchCourseFolderFromRecipients(toAddresses, body){
  const addresses = [...(toAddresses || []), ...extractAddresses(forwardedHeaderLines(body, "To"))];
  return matchAddressTable(addresses, COURSE_RECIPIENT_ADDRESSES);
}

function matchCourseFolderFromSender(from, body, subject){
  const addresses = extractAddresses(`${from || ""}\n${forwardedHeaderLines(body, "From")}`);
  const folder = matchAddressTable(addresses, COURSE_SENDER_ADDRESSES);
  if (folder) return folder;
  if (addresses.includes(CANVAS_NOTIFICATION_SENDER)){
    const match = CANVAS_SUBJECT_COURSES.find(c => String(subject || "").toLowerCase().includes(c.subject.toLowerCase()));
    if (match) return match.folder;
  }
  return null;
}

function classifyEmailCourse({ toAddresses, from, subject, body }){
  return matchCourseFolderFromRecipients(toAddresses, body) ||
    matchCourseFolderFromSender(from, body, subject) ||
    "uncategorized";
}

async function graphGet(accessToken, url, extraHeaders){
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...extraHeaders
    }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || `Graph returned ${res.status}`;
    throw new Error(message);
  }
  return data;
}

// Deletes one message from the actual mailbox (Graph's DELETE moves it to
// Deleted Items, the same as deleting it by hand in Outlook) -- used by the
// Email tab's Delete button, which removes it from both the mailbox and
// this app's local store together. A 404 here means it's already gone from
// Outlook (deleted by hand, or by a previous attempt that succeeded on the
// Graph side but failed before the local delete ran) -- treated as success
// rather than blocking the local delete on it.
async function graphDeleteMessage(accessToken, messageId){
  const res = await fetch(`${GRAPH_ROOT}/me/messages/${messageId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.ok || res.status === 404) return;
  const data = await res.json().catch(() => null);
  const message = (data && data.error && data.error.message) || `Graph returned ${res.status}`;
  throw new Error(message);
}

// Finds the target folder by display name -- checked case-insensitively,
// first among top-level folders, then (since an Outlook rule can create its
// "move to" folder nested under Inbox instead of at the top level) among
// Inbox's child folders. Throws a specific, listable error if neither turns
// it up, since Outlook's IMAP-visible folder name and its Graph displayName
// aren't guaranteed to be spelled identically to what the user typed into
// EMAIL_FOLDER.
async function findFolder(accessToken, folderName){
  const topLevel = await graphGet(accessToken, `${GRAPH_ROOT}/me/mailFolders?$top=250`);
  let match = (topLevel.value || []).find(f => (f.displayName || "").toLowerCase() === folderName.toLowerCase());
  if (match) return match;

  const children = await graphGet(accessToken, `${GRAPH_ROOT}/me/mailFolders/inbox/childFolders?$top=250`);
  match = (children.value || []).find(f => (f.displayName || "").toLowerCase() === folderName.toLowerCase());
  if (match) return match;

  const available = (topLevel.value || []).map(f => f.displayName)
    .concat((children.value || []).map(f => `Inbox/${f.displayName}`));
  throw new Error(`No folder named "${folderName}" found in this mailbox. Available folders: ${available.join(", ")}`);
}

// Follows Graph's delta pagination (@odata.nextLink) until the final page,
// which carries @odata.deltaLink instead -- that's the watermark to store
// for next time, since re-requesting it returns only what's changed since
// this sync. Deleted-item entries (`@removed`) are filtered out; we only
// care about additions.
async function fetchDeltaMessages(accessToken, folderId, storedDeltaLink){
  let url = storedDeltaLink || `${GRAPH_ROOT}/me/mailFolders/${folderId}/messages/delta?$select=${MESSAGE_FIELDS}`;
  const messages = [];
  let deltaLink = storedDeltaLink;

  while (url) {
    const page = await graphGet(accessToken, url, { Prefer: 'outlook.body-content-type="text"' });
    for (const item of (page.value || [])) {
      if (!item["@removed"]) messages.push(item);
    }
    if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
    url = page["@odata.nextLink"] || null;
  }

  return { messages, deltaLink };
}

// Moves a document's on-disk file (and its documentStore record) into its
// newly-reclassified course folder -- used by reclassifyStaleMessages below.
// No-ops safely (just updates the record) for a document with no on-disk file
// at all, and leaves the record untouched if the move itself fails (e.g. the
// file was already moved or deleted by hand) rather than throwing mid-sync.
function moveDocumentToCourseFolder(document, newFolder){
  if (!document.filePath) {
    documentStore.updateDocument(document.id, { courseId: newFolder, courseName: newFolder });
    return;
  }
  const newFilePath = path.join(newFolder, document.fileName || path.basename(document.filePath));
  const oldFullPath = path.join(DOCS_ROOT, document.filePath);
  const newFullPath = path.join(DOCS_ROOT, newFilePath);
  try {
    fs.mkdirSync(path.join(DOCS_ROOT, newFolder), { recursive: true });
    fs.renameSync(oldFullPath, newFullPath);
  } catch (err) {
    return;
  }
  documentStore.updateDocument(document.id, { courseId: newFolder, courseName: newFolder, filePath: newFilePath });
}

// Bumped whenever the classification rules above change, so every stored
// message (not just "uncategorized" ones) gets re-run against the new rules
// once -- e.g. the switch to sender/recipient-only classification moves a
// newsletter that was filed under Torts on a body-text match back out.
const CLASSIFIER_VERSION = 2;

// Re-runs classification for stored messages classified under older rules,
// plus every still-uncategorized message (so extending the address lists
// later picks them up too). Run at the end of every /sync. A message's
// documents and calendar events follow it to its new course. Messages
// synced before `toAddresses` was stored get it re-fetched from Graph once.
// Moves a stored message -- along with the documents it downloaded and the
// calendar events extracted from it -- to `newFolder`, saving any extra
// fields in `patch` on the message too. Returns true if the course changed.
async function applyMessageCourse(userId, message, newFolder, patch){
  const changed = newFolder !== message.courseFolder;
  if (changed){
    for (const docId of (message.documentIds || [])){
      const document = documentStore.getDocument(docId);
      if (document) moveDocumentToCourseFolder(document, newFolder);
    }
    await calendarStore.updateEventsForMessage(userId, message.id, { courseFolder: newFolder });
  }
  await emailStore.updateMessage(userId, message.id, { ...patch, courseFolder: newFolder });
  return changed;
}

// Recipients for classifying a stored message: what was saved at sync time,
// or -- for messages synced before `toAddresses` was stored -- re-fetched
// from Graph. Null if neither works (e.g. the message was moved or deleted
// from the mailbox since it was synced); the sender check still runs then.
async function storedRecipientAddresses(message, accessToken){
  if (Array.isArray(message.toAddresses)) return message.toAddresses;
  if (!accessToken) return null;
  try {
    const data = await graphGet(accessToken, `${GRAPH_ROOT}/me/messages/${message.id}?$select=toRecipients`);
    return recipientAddresses(data.toRecipients);
  } catch (err) { return null; }
}

async function reclassifyStaleMessages(userId, accessToken){
  const state = await emailStore.load(userId);
  let reclassified = 0;

  for (const message of state.messages){
    // A course the user picked by hand (right-click on the Email tab's
    // course pill) is never overridden by the automatic rules.
    if (message.courseManual) continue;
    if (message.classifierVersion === CLASSIFIER_VERSION && message.courseFolder !== "uncategorized") continue;

    const toAddresses = await storedRecipientAddresses(message, accessToken);
    const newFolder = classifyEmailCourse({ toAddresses, from: message.from, subject: message.subject, body: message.body });
    const patch = { classifierVersion: CLASSIFIER_VERSION };
    if (toAddresses) patch.toAddresses = toAddresses;
    if (await applyMessageCourse(userId, message, newFolder, patch)) reclassified++;
  }

  return reclassified;
}

router.post("/sync", async (req, res) => {
  const userId = req.session.userId;
  const tokenResult = await getAccessTokenSilent(userId);
  if (tokenResult.error) {
    return res.status(401).json({ error: { message: tokenResult.error } });
  }
  const accessToken = tokenResult.accessToken;
  const { folder: folderName } = await getEmailConfig(userId);
  if (!folderName) {
    return res.status(400).json({ error: { message: "No email folder configured yet. Set one in Settings before syncing." } });
  }
  const state = await emailStore.load(userId);

  try {
    const folder = await findFolder(accessToken, folderName);
    const { messages: rawMessages, deltaLink } = await fetchDeltaMessages(accessToken, folder.id, state.deltaLinks[FOLDER_KEY]);

    const newMessages = [];
    const newCalendarEvents = [];
    const newDocuments = [];
    let documentsDownloaded = 0;

    for (const msg of rawMessages) {
      const subject = msg.subject || "(no subject)";
      // Proofpoint-wrapped links unwrapped up front (see email-links.js) --
      // shorter, so the stored copy (capped at MAX_BODY_CHARS) keeps a
      // digest's later links intact, and its links are the real ones.
      const bodyText = unwrapLinksInText((msg.body && msg.body.content) || "");

      const senderText = (msg.from && msg.from.emailAddress) ? `${msg.from.emailAddress.name || ""} <${msg.from.emailAddress.address || ""}>` : "";
      const toAddresses = recipientAddresses(msg.toRecipients);
      const courseFolder = classifyEmailCourse({ toAddresses, from: senderText, subject, body: bodyText });

      const documentIds = [];
      if (msg.hasAttachments) {
        const attachmentsRes = await graphGet(accessToken, `${GRAPH_ROOT}/me/messages/${msg.id}/attachments`);
        for (const attachment of (attachmentsRes.value || [])) {
          if (attachment["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
          if (!attachment.name || !isDocumentAttachment(attachment.name, attachment.contentType)) continue;

          // Check for this same file under ANY course folder first, not just
          // the one this message's course guess landed on -- an email that
          // the classifier can't tie to a course (falls through to
          // "uncategorized") very often carries an attachment that's already
          // correctly filed under its real course from a Canvas import or an
          // earlier, better-classified email. Without this, that file gets
          // re-downloaded into documents/uncategorized/ and a second,
          // permanent document-store record is created for the same content
          // -- the same "same entity, two records" bug the quiz-scrape fixes
          // (4b72611, fbd0ce7) addressed, just via this path instead.
          const baseName = deriveBaseName(attachment.name).toLowerCase();
          const crossFolderExisting = documentStore.getAllDocuments()
            .find(doc => doc.fileName && deriveBaseName(doc.fileName).toLowerCase() === baseName);
          if (crossFolderExisting) {
            documentIds.push(crossFolderExisting.id);
            continue;
          }

          // Also check this account's own previously-downloaded documents --
          // re-syncing mail that was already pulled in on an earlier sync
          // shouldn't create a second private copy for the same file.
          const ownExisting = await userDocumentStore.getDocumentByFileName(userId, attachment.name);
          if (ownExisting) {
            documentIds.push(ownExisting.id);
            continue;
          }

          const buffer = Buffer.from(attachment.contentBytes, "base64");

          // Unlike Canvas imports, an emailed attachment is this one
          // account's own mail -- on a shared deployment, saving it into the
          // shared documents/<course>/ folder and shared documentStore would
          // show up for every other signed-in user too. Stored instead in
          // this account's own Supabase-backed table (see
          // user-document-store.js), never touching disk.
          const extracted = await extractText(buffer, attachment.contentType || "", attachment.name);
          const extractError = (extracted && typeof extracted === "object" && extracted.__error) ? extracted.__error : null;
          const fileBuffer = buffer.length <= MAX_STORED_PDF_BYTES ? buffer : null;

          const document = await userDocumentStore.addDocument(userId, {
            title: attachment.name,
            contentType: attachment.contentType || "",
            text: extractError ? null : (extracted || null),
            courseId: courseFolder,
            courseName: courseFolder,
            fileBuffer,
            fileName: attachment.name
          });
          if (!document) continue;

          documentIds.push(document.id);
          documentsDownloaded++;
          newDocuments.push({ id: document.id, title: document.title, fileName: document.fileName, courseFolder });
        }
      }

      // Delegated to Claude Code (calendar-extract.js) rather than a local
      // date-pattern parser -- telling "the review session is Friday at 2pm"
      // (a real event) apart from "thank you for attending the review
      // session earlier today" (a past reference, not an event) needs actual
      // reading comprehension, not just date-shaped-text matching. Left
      // unchecked (calendarChecked stays false) on failure/timeout so the
      // one-time backfill (calendar-backfill.js) can retry it later instead
      // of silently treating a failed check as "nothing to find".
      const messageForEvents = {
        id: msg.id, subject, body: bodyText, date: msg.receivedDateTime || null, courseFolder,
        attachmentLinks: await attachmentLinksText(userId, documentIds).catch(() => "")
      };
      let calendarChecked = false;
      try {
        const { events, sessionId } = await extractCalendarEventsForMessage(messageForEvents);
        // Stamped onto each event so the Email tab's "calendar event found"
        // sync-result popup can show, per event, the exact Claude Code
        // session that extracted it (`claude --resume <sessionId>`) --
        // persisted alongside the event itself (see calendarStore.addEvents)
        // so it's still there on a later page load, not just this response.
        events.forEach(ev => { ev.sessionId = sessionId; });
        newCalendarEvents.push(...events);
        calendarChecked = true;
      } catch (err) {
        console.error("Calendar extraction failed for message", msg.id, err.message);
      }

      newMessages.push({
        id: msg.id,
        subject,
        from: (msg.from && msg.from.emailAddress &&
          (msg.from.emailAddress.name ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>` : msg.from.emailAddress.address)
        ) || "(unknown sender)",
        date: msg.receivedDateTime || null,
        body: bodyText.slice(0, MAX_BODY_CHARS),
        courseFolder,
        toAddresses,
        classifierVersion: CLASSIFIER_VERSION,
        documentIds,
        calendarChecked,
        done: false,
        plan: null,
        planError: null,
        planGeneratedAt: null,
        agentStatus: "idle",
        agentStartedAt: null,
        agentTerminal: null
      });
    }

    await emailStore.addMessages(userId, newMessages, FOLDER_KEY, deltaLink);
    await calendarStore.addEvents(userId, newCalendarEvents);
    const reclassified = await reclassifyStaleMessages(userId, accessToken);

    // Plans are only drafted when the user actually asks for one -- via the
    // Email tab's "Generate plan" button (POST /messages/:id/plan below) --
    // never automatically at sync time. Generating a plan for every synced
    // email unasked meant OpenAI calls (and a plausible-looking but
    // sometimes fabricated plan) for emails the user never intended to act
    // on.
    res.json({
      added: newMessages.length,
      documentsDownloaded,
      eventsFound: newCalendarEvents.length,
      reclassified,
      messages: await emailStore.getAll(userId),
      // Full records behind each count above, so the Email tab's sync-result
      // popups ("3 new emails", "0 documents downloaded", "1 calendar event
      // found") have something to actually list when clicked, instead of
      // just the bare number.
      newMessages,
      newDocuments,
      newCalendarEvents
    });
  } catch (err) {
    console.error("Email sync failed:", err);
    res.status(500).json({ error: { message: err.message || "Email sync failed." } });
  }
});

router.get("/messages", async (req, res) => {
  const userId = req.session.userId;
  const tokenResult = await getAccessTokenSilent(userId);
  res.json({ messages: await emailStore.getAll(userId), configured: !tokenResult.error });
});

// Deletes an email from both the actual Outlook mailbox and this app's
// local store -- a destructive, cross-system action, so the frontend
// confirms with the user before ever calling this.
router.delete("/messages/:id", async (req, res) => {
  const userId = req.session.userId;
  const message = await emailStore.getMessage(userId, req.params.id);
  if (!message) return res.status(404).json({ error: { message: "No synced email with that id." } });

  const tokenResult = await getAccessTokenSilent(userId);
  if (tokenResult.error) {
    return res.status(401).json({ error: { message: tokenResult.error } });
  }

  try {
    await graphDeleteMessage(tokenResult.accessToken, message.id);
  } catch (err) {
    return res.status(502).json({ error: { message: `Couldn't delete this email from Outlook: ${err.message}` } });
  }

  await emailStore.deleteMessage(userId, message.id);
  res.json({ ok: true });
});

const COURSE_FOLDERS = ["civil_procedure", "contracts", "torts", "lawyering_skills_and_strategies", "uncategorized"];

// Sets an email's course by hand (the Email tab's right-click menu on the
// course pill). Its documents and calendar events move with it, and the
// choice sticks -- reclassifyStaleMessages skips it from then on. Sending
// { courseFolder: null } clears the manual choice and re-runs the automatic
// sender/recipient rules on it instead.
router.put("/messages/:id/course", async (req, res) => {
  const userId = req.session.userId;
  const { courseFolder } = req.body || {};
  if (courseFolder !== null && !COURSE_FOLDERS.includes(courseFolder)) {
    return res.status(400).json({ error: { message: "Unknown course." } });
  }
  const message = await emailStore.getMessage(userId, req.params.id);
  if (!message) return res.status(404).json({ error: { message: "No synced email with that id." } });

  if (courseFolder) {
    await applyMessageCourse(userId, message, courseFolder, { courseManual: true });
  } else {
    const tokenResult = await getAccessTokenSilent(userId);
    const toAddresses = await storedRecipientAddresses(message, tokenResult.error ? null : tokenResult.accessToken);
    const newFolder = classifyEmailCourse({ toAddresses, from: message.from, subject: message.subject, body: message.body });
    const patch = { courseManual: false, classifierVersion: CLASSIFIER_VERSION };
    if (toAddresses) patch.toAddresses = toAddresses;
    await applyMessageCourse(userId, message, newFolder, patch);
  }
  res.json(await emailStore.getMessage(userId, message.id));
});

router.post("/messages/:id/done", async (req, res) => {
  const { done } = req.body || {};
  const message = await emailStore.markDone(req.session.userId, req.params.id, done !== false);
  if (!message) return res.status(404).json({ error: { message: "No synced email with that id." } });
  res.json(message);
});

// (Re)generates the plan for one message via OpenAI -- used for the initial
// draft's retry button, and for a plan the user wants regenerated from
// scratch after editing it.
router.post("/messages/:id/plan", async (req, res) => {
  const userId = req.session.userId;
  const message = await emailStore.getMessage(userId, req.params.id);
  if (!message) return res.status(404).json({ error: { message: "No synced email with that id." } });

  const updated = await generateAndStorePlan(userId, message.id);
  if (updated.planError && !updated.plan) return res.status(500).json(updated);
  res.json(updated);
});

// Saves the user's own edits to a plan (made in the Email tab's textarea)
// without touching OpenAI.
router.put("/messages/:id/plan", async (req, res) => {
  const { plan } = req.body || {};
  if (typeof plan !== "string") {
    return res.status(400).json({ error: { message: "Missing 'plan' string in request body." } });
  }
  const updated = await emailStore.updateMessage(req.session.userId, req.params.id, { plan, planError: null });
  if (!updated) return res.status(404).json({ error: { message: "No synced email with that id." } });
  res.json(updated);
});

// Runs the Claude Code CLI headlessly (see agent-runtime.js) to carry out
// the (possibly user-edited) plan, in the lawgpt repo. Runs with
// --permission-mode auto (not --dangerously-skip-permissions) so it still
// asks before anything destructive or outside its usual bounds, while
// proceeding through the routine, low-risk tool calls on its own -- nobody's
// watching a terminal here to approve them one at a time. The run is
// recorded under agent-store.js (per-account, same as email/notes state) and
// the response just carries its id; the Agent tab is what actually opens it
// and streams the live output (see agent-routes.js).
router.post("/messages/:id/agent/run", async (req, res) => {
  const userId = req.session.userId;
  const message = await emailStore.getMessage(userId, req.params.id);
  if (!message) return res.status(404).json({ error: { message: "No synced email with that id." } });
  if (!message.plan || !message.plan.trim()) {
    return res.status(400).json({ error: { message: "Generate (or write) a plan before sending this to the agent." } });
  }

  const agentPrompt =
    "You are carrying out the task plan below, drafted from a law-school course email. " +
    "You may read this repository for context -- it's organized as documents/<course>/ for source material and " +
    "notes/<course>/ for the student's own hand-written notes -- but do not create, edit, or save any files " +
    "anywhere in it for your deliverable. This is running headless with no one watching a terminal: your complete " +
    "final response (not any file you write) is what gets saved and shown to the user, so the whole deliverable " +
    "the plan calls for must be written out directly in your response text, in full -- not summarized, not left " +
    "in a file, and not just a description of what you would have produced. " +
    "This is also running unattended: if a step is ambiguous, use your best judgment and proceed rather than " +
    "stopping to ask a question nobody will see.\n\n" +
    "Plan:\n" + message.plan +
    "\n\n---\n\nThe plan above was drafted from this email -- use it for any specifics (links, dates, names, " +
    "addresses) the plan itself doesn't spell out:\n\n" + await buildPlanContext(message, userId);

  const runId = crypto.randomUUID();
  await agentStore.createRun(userId, {
    id: runId,
    title: message.subject || "Agent run",
    prompt: agentPrompt,
    source: { type: "email", messageId: message.id }
  });
  agentRuntime.startRun(userId, runId, agentPrompt, REPO_ROOT);

  const updated = await emailStore.updateMessage(userId, message.id, {
    agentStatus: "running",
    agentStartedAt: new Date().toISOString(),
    agentRunId: runId
  });
  res.json(updated);
});

module.exports = router;
// Attached so this can be unit-tested directly without a live Graph
// connection.
module.exports.matchCourseFolderFromRecipients = matchCourseFolderFromRecipients;
