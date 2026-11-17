// pdf-documents.js
//
// Shared by server.js (Notes generation through /api/chat) and
// agent-routes.js (the Complete buttons' agent runs) for sending an attached
// document to Claude Code as the actual PDF file instead of its extracted
// text -- the only way a scanned/image-only PDF (where text extraction comes
// back empty) can be read at all.

// True only for an attached document whose stored original bytes are a PDF.
// fileBuffer alone isn't enough: Canvas imports and local scans only keep
// bytes for PDFs, but email-routes.js keeps them for any attachment under
// the size cap (a .docx included), and those must not be sent to a model
// labeled application/pdf.
function isPdfDocument(doc) {
  return Boolean(doc && doc.fileBuffer) &&
    (/pdf/i.test(doc.contentType || "") || /\.pdf$/i.test(doc.fileName || doc.title || ""));
}

// One newline-terminated `claude -p --input-format stream-json` user message:
// each PDF as a base64 document block (titled with its file name, so the
// model can tell which is which), followed by the text prompt.
function streamJsonUserMessage(text, pdfFiles) {
  const content = [
    ...(pdfFiles || []).map(file => ({
      type: "document",
      title: file.name,
      source: { type: "base64", media_type: "application/pdf", data: file.buffer.toString("base64") }
    })),
    { type: "text", text: text || "" }
  ];
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

module.exports = { isPdfDocument, streamJsonUserMessage };
