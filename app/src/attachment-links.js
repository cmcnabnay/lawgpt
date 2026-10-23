// attachment-links.js
//
// Links inside an email's attached PDFs. A flyer often carries the event's
// registration link only as a clickable annotation over its text ("please
// register your interest" -> https://...), while the email itself just says
// "register using the link in the attached flyer". Text extraction (see
// canvas-routes.js's extractText) drops annotations, so the link never
// reached calendar-extract.js and the RSVP pill had nothing to open. Each
// link here is read straight from the PDF's link annotations and labeled
// with the words under it, then listed after the email body so Claude can
// pick it like any of the email's own links.

const userDocumentStore = require("./user-document-store");

const MAX_LINKS_PER_ATTACHMENT = 20;

// pdfjs-dist ships as ES modules only -- loaded once, lazily, via import().
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

// The part of a text run that sits inside a link's rectangle -- runs often
// extend past the link ("register your interest. Space is limited, ..."),
// so the run is cut proportionally by x position.
function textInRect(items, [x1, y1, x2, y2]) {
  const parts = [];
  for (const item of items) {
    const x = item.transform[4], y = item.transform[5];
    const width = item.width || 0, height = item.height || 8;
    if (!item.str || !width || x >= x2 || x + width <= x1 || y >= y2 || y + height <= y1) continue;
    const start = Math.max(0, Math.floor(((x1 - x) / width) * item.str.length));
    const end = Math.min(item.str.length, Math.ceil(((x2 - x) / width) * item.str.length));
    parts.push(item.str.slice(start, end));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Returns [{ text, url }] for every http(s) link annotation in a PDF, or []
// if it can't be read.
async function pdfLinks(buffer) {
  let doc;
  try {
    const pdfjs = await loadPdfjs();
    doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
    const links = [];
    const seen = new Set();
    for (let i = 1; i <= doc.numPages && links.length < MAX_LINKS_PER_ATTACHMENT; i++) {
      const page = await doc.getPage(i);
      const annotations = await page.getAnnotations();
      const { items } = await page.getTextContent();
      for (const a of annotations) {
        const url = a.subtype === "Link" && (a.url || a.unsafeUrl);
        if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        links.push({ text: textInRect(items, a.rect).slice(0, 80), url });
        if (links.length >= MAX_LINKS_PER_ATTACHMENT) break;
      }
    }
    return links;
  } catch (err) {
    return [];
  } finally {
    if (doc) doc.destroy().catch(() => {});
  }
}

// Builds the "links inside the attachments" block for one email, from its
// documentIds in this account's own document store (a shared Canvas
// document isn't there and is skipped). Empty string when there's nothing.
async function attachmentLinksText(userId, documentIds) {
  const sections = [];
  for (const id of documentIds || []) {
    const document = await userDocumentStore.getDocument(userId, id);
    if (!document || !document.fileBuffer) continue;
    const isPdf = /pdf/i.test(document.contentType || "") || /\.pdf$/i.test(document.fileName || "");
    if (!isPdf) continue;
    const links = await pdfLinks(document.fileBuffer);
    if (!links.length) continue;
    const lines = links.map(l => `- ${l.text ? `"${l.text}"` : "(image link)"}: ${l.url}`);
    sections.push(`ATTACHED FILE "${document.fileName || document.title}" -- clickable links inside it:\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

module.exports = { pdfLinks, attachmentLinksText };
