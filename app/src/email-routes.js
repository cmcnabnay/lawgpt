// email-routes.js
//
// Syncs a configurable folder (see EMAIL_FOLDER / Settings) of a personal
// mailbox that the user has set up to auto-forward their school email into,
// downloads any course document
// attachments into documents/<course>/ (reusing the exact same
// save/extract/index pipeline canvas-routes.js uses for Canvas imports), and
// flags messages that look like they describe an assignment.
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
const crypto = require("crypto");

const documentStore = require("./document-store");
const emailStore = require("./email-store");
const canvasRoutes = require("./canvas-routes");
const { extractText, saveNativeFile, matchCourseFolder, isDocumentAttachment, extFromContentTypeOrTitle } = canvasRoutes;
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
const MESSAGE_FIELDS = "subject,from,receivedDateTime,hasAttachments,body";

// The lawgpt project root (two levels up from app/src/) -- the directory
// the "send to agent" feature below opens a terminal in and runs the Claude
// Code CLI from, so a plan that says "save this to agent/<course>/..." lands
// in the same repo the Documents/Notes tabs read from. agent/ is a
// dedicated folder (created alongside documents/ and notes/) that holds
// only this feature's output, kept separate from documents/ (source
// material) and notes/ (the student's own hand-written notes).
const REPO_ROOT = path.join(__dirname, "..", "..");
const AGENT_OUTPUT_DIR = "agent";

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

function gatherAttachmentTextForPlan(message){
  return (message.documentIds || [])
    .map(id => documentStore.getDocument(id))
    .filter(doc => doc && doc.text)
    .map(doc => `ATTACHMENT: ${doc.fileName || doc.title}\n\n${doc.text.slice(0, MAX_ATTACHMENT_CHARS_FOR_PLAN)}`)
    .join("\n\n---\n\n");
}

const PLAN_DEVELOPER_TEXT =
  "You are drafting a short, concrete task plan for an autonomous coding agent (Claude Code) that will be run " +
  "unattended, with full read/write access to a law student's course-notes repository (organized as " +
  "documents/<course>/ for source material and notes/<course>/ for the student's own hand-written notes -- " +
  "neither of which this agent should touch). " +
  "The user explicitly asked for a plan for the email below, so always produce one -- never refuse or say there's " +
  "nothing to do. Write a numbered checklist of concrete, actionable steps the agent should take -- naming the " +
  "specific reading/case/problem, what deliverable to produce (e.g. a case brief, a written answer, an outline), " +
  "and roughly where to save it: everything this agent produces belongs under agent/<course>/ (e.g. " +
  "agent/contracts/2-207-practice-problem.md), never under documents/ or notes/. " +
  "Base every step strictly on what the email and any attachment text below actually say -- never invent a " +
  "professor's name, case, reading, or deliverable that isn't actually named in them. If the email doesn't " +
  "describe a concrete assignment or deliverable, the plan should say so as its first step (e.g. \"Re-read the " +
  "email -- it doesn't appear to require a deliverable\") and, if there's anything else in it worth noting (a " +
  "date, a link, an event), make a later step out of that instead of inventing coursework that isn't there. " +
  "Do not include generic advice or disclaimers. Keep it under 10 steps. Output only the numbered list, nothing else.";

function buildPlanContext(message){
  const attachmentText = gatherAttachmentTextForPlan(message);
  return [
    `Subject: ${message.subject}`,
    `From: ${message.from}`,
    message.date ? `Received: ${message.date}` : "",
    message.assignmentSnippet ? `Flagged sentence: "${message.assignmentSnippet}"` : "",
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
        { role: "user", content: [{ type: "input_text", text: buildPlanContext(message) }] }
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

// Keyword heuristics for "this email describes something to do", in the
// same spirit as the classifyCivProReading/classifyLssAssignment functions
// in lawgpt.html -- fast, free, no per-email API call. Checked against
// subject+body together; the snippet returned is the first sentence that
// actually matched, so the UI can show *why* something was flagged instead
// of just a bare yes/no.
const ASSIGNMENT_KEYWORDS = /\b(due|assignment|practice problem|distributed|submit|homework|deadline|exercise)\b/i;

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

function classifyEmailAssignment(subject, text){
  const combined = `${subject || ""}\n${text || ""}`;
  if (!ASSIGNMENT_KEYWORDS.test(combined)) {
    return { isAssignment: false, snippet: null };
  }

  // Best-effort: split on sentence-ish boundaries and surface the first one
  // that actually contains a matched keyword, so the card shows relevant
  // context rather than the whole email body.
  const sentences = combined.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const hit = sentences.find(s => ASSIGNMENT_KEYWORDS.test(s));
  const snippet = (hit || subject || "").slice(0, 300);

  return { isAssignment: true, snippet };
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
    let assignmentsFound = 0;
    let documentsDownloaded = 0;

    for (const msg of rawMessages) {
      const subject = msg.subject || "(no subject)";
      const bodyText = (msg.body && msg.body.content) || "";
      const combinedText = `${subject}\n${bodyText}`;

      const courseFolder = matchCourseFolder(combinedText) || "uncategorized";
      const { isAssignment, snippet: assignmentSnippet } = classifyEmailAssignment(subject, bodyText);
      if (isAssignment) assignmentsFound++;

      const documentIds = [];
      if (msg.hasAttachments) {
        const attachmentsRes = await graphGet(accessToken, `${GRAPH_ROOT}/me/messages/${msg.id}/attachments`);
        for (const attachment of (attachmentsRes.value || [])) {
          if (attachment["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
          if (!attachment.name || !isDocumentAttachment(attachment.name, attachment.contentType)) continue;

          const buffer = Buffer.from(attachment.contentBytes, "base64");
          const ext = extFromContentTypeOrTitle(attachment.contentType, attachment.name);
          const nativeFile = saveNativeFile(courseFolder, attachment.name, ext, buffer);
          if (!nativeFile) continue;

          const existing = documentStore.getDocumentByFilePath(nativeFile.filePath);
          if (existing) documentStore.removeDocument(existing.id);

          const extracted = await extractText(buffer, attachment.contentType || "", attachment.name);
          const extractError = (extracted && typeof extracted === "object" && extracted.__error) ? extracted.__error : null;
          const isPdf = ext === "pdf";
          const fileBuffer = isPdf && buffer.length <= MAX_STORED_PDF_BYTES ? buffer : null;

          const document = documentStore.addDocument({
            title: attachment.name,
            url: null,
            contentType: attachment.contentType || "",
            text: extractError ? null : (extracted || null),
            courseId: courseFolder,
            courseName: courseFolder,
            fileBuffer,
            fileName: nativeFile.fileName,
            filePath: nativeFile.filePath
          });

          documentIds.push(document.id);
          documentsDownloaded++;
        }
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
        isAssignment,
        assignmentSnippet,
        documentIds,
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

    // Plans are only drafted when the user actually asks for one -- via the
    // Email tab's "Generate plan" button (POST /messages/:id/plan below) --
    // not automatically for every assignment-flagged email a sync turns up.
    // A keyword match alone (see classifyEmailAssignment) is a loose enough
    // signal that plenty of flagged emails aren't real assignments at all;
    // generating a plan for all of them unasked meant OpenAI calls (and a
    // plausible-looking but sometimes fabricated plan) for emails the user
    // never intended to act on.
    res.json({
      added: newMessages.length,
      assignmentsFound,
      documentsDownloaded,
      messages: await emailStore.getAll(userId)
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
    "Work directly in this repository. It's organized as documents/<course>/ for source material and " +
    "notes/<course>/ for the student's own hand-written notes -- do not create or edit anything in either of " +
    `those; everything you produce belongs under ${AGENT_OUTPUT_DIR}/<course>/ instead. ` +
    "This is running unattended: if a step is ambiguous, use your best judgment and proceed rather than " +
    "stopping to ask a question nobody will see. Make sure any deliverable the plan calls for actually ends up " +
    `saved to a file under ${AGENT_OUTPUT_DIR}/, not just printed.\n\n` + message.plan;

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
module.exports.classifyEmailAssignment = classifyEmailAssignment;
