// email-routes.js
//
// Syncs the "Forwarded" folder of a personal mailbox that the user has set
// up to auto-forward their school email into, downloads any course document
// attachments into documents/<course>/ (reusing the exact same
// save/extract/index pipeline canvas-routes.js uses for Canvas imports), and
// flags messages that look like they describe an assignment.
//
// Talks to Microsoft Graph's REST API rather than IMAP -- IMAP with a plain
// app password turned out to be rejected outright by this account
// ("AUTHENTICATE failed. Provided authentication mechanism is not
// supported."), because Microsoft now requires OAuth2 for IMAP too, not
// just basic-auth passwords. Graph sidesteps that: it's plain HTTPS with a
// bearer token. See email-auth.js for how that token is obtained/cached,
// and setup-email-auth.js for the one-time interactive sign-in.
//
// This route only ever calls email-auth.js's getAccessTokenSilent() --
// never anything interactive -- so a request here can't hang waiting on a
// login. If there's no cached, refreshable token yet, it responds with a
// clear "run the setup script" error instead.

const express = require("express");
const router = express.Router();

const documentStore = require("./document-store");
const emailStore = require("./email-store");
const canvasRoutes = require("./canvas-routes");
const { extractText, saveNativeFile, matchCourseFolder, isDocumentAttachment, extFromContentTypeOrTitle } = canvasRoutes;
const { getAccessTokenSilent, getEmailConfig } = require("./email-auth");

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const MAX_STORED_PDF_BYTES = 20 * 1024 * 1024; // same cap canvas-routes.js uses
const MESSAGE_FIELDS = "subject,from,receivedDateTime,hasAttachments,body";

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
  const tokenResult = await getAccessTokenSilent();
  if (tokenResult.error) {
    return res.status(401).json({ error: { message: tokenResult.error } });
  }
  const accessToken = tokenResult.accessToken;
  const { folder: folderName } = getEmailConfig();
  const state = emailStore.load();

  try {
    const folder = await findFolder(accessToken, folderName);
    const { messages: rawMessages, deltaLink } = await fetchDeltaMessages(accessToken, folder.id, state.deltaLink);

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
        snippet: bodyText.slice(0, 300),
        courseFolder,
        isAssignment,
        assignmentSnippet,
        documentIds,
        done: false
      });
    }

    emailStore.addMessages(newMessages, deltaLink);

    res.json({
      added: newMessages.length,
      assignmentsFound,
      documentsDownloaded,
      messages: emailStore.getAll()
    });
  } catch (err) {
    console.error("Email sync failed:", err);
    res.status(500).json({ error: { message: err.message || "Email sync failed." } });
  }
});

router.get("/messages", async (req, res) => {
  const tokenResult = await getAccessTokenSilent();
  res.json({ messages: emailStore.getAll(), configured: !tokenResult.error });
});

router.post("/messages/:id/done", (req, res) => {
  const { done } = req.body || {};
  const message = emailStore.markDone(req.params.id, done !== false);
  if (!message) return res.status(404).json({ error: { message: "No synced email with that id." } });
  res.json(message);
});

module.exports = router;
// Attached so this can be unit-tested directly without a live Graph
// connection.
module.exports.classifyEmailAssignment = classifyEmailAssignment;
