const crypto = require("crypto");

const documents = new Map();

// addedAt defaults to "now" (a fresh Canvas/email import or quiz scrape
// really was just created), but a caller can pass its own -- local-scan.js
// does, using the file's actual on-disk mtime, so a file that's sat in
// documents/<course>/ since before this server process even started shows
// its real last-modified time instead of whatever moment the scan happened
// to run.
function addDocument(document) {
  const id = crypto.randomUUID();

  const storedDocument = {
    id,
    ...document,
    addedAt: document.addedAt || new Date().toISOString()
  };

  documents.set(id, storedDocument);

  return storedDocument;
}

function getDocument(id) {
  return documents.get(id) || null;
}

function getAllDocuments() {
  return Array.from(documents.values());
}

function getDocumentsByCourse(courseId) {
  return Array.from(documents.values())
    .filter(doc => String(doc.courseId) === String(courseId));
}

// Used by local-scan.js to skip re-registering a file that's already been
// indexed (either by a previous scan, or by a Canvas import that saved to
// the same path) — filePath is the one stable identity a file on disk has
// across server restarts, unlike the random id assigned on each addDocument.
function getDocumentByFilePath(filePath) {
  for (const document of documents.values()) {
    if (document.filePath === filePath) return document;
  }
  return null;
}

function removeDocument(id) {
  return documents.delete(id);
}

function clearDocuments() {
  documents.clear();
}

function searchDocuments(query, limit = 5) {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length >= 4);

  const results = [];

  for (const document of documents.values()) {
    if (!document.text) continue;

    const text = document.text.toLowerCase();

    let score = 0;

    for (const word of words) {
      if (text.includes(word)) {
        score++;
      }
    }

    if (score > 0) {
      results.push({
        document,
        score
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(result => result.document);
}

module.exports = {
  addDocument,
  getDocument,
  getAllDocuments,
  getDocumentsByCourse,
  getDocumentByFilePath,
  removeDocument,
  clearDocuments,
  searchDocuments
};

