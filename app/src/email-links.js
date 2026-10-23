// email-links.js
//
// Link handling for synced email bodies. Graph's text bodies (see
// email-routes.js's Prefer: outlook.body-content-type="text") render each
// link as `label<url>`, and the school's mail filter wraps every one in a
// Proofpoint redirect -- https://urldefense.com/v3/__<real url>__;<…>!!<id>!<sig>$
// -- which roughly triples a link's length. That wrapping is what pushed
// digest emails past the stored-body cap (cutting their later links off
// mid-URL) and what made asking Claude to copy a link back character for
// character slow and unreliable.

const URL_DEFENSE_RE = /^https?:\/\/urldefense(?:\.proofpoint)?\.com\/v3\/__(.+?)__;([^!]*)!!/i;
const URL_RE = /https?:\/\/[^\s<>"]+/g;

// Returns the real link behind a Proofpoint v3 wrapper, the URL unchanged if
// it isn't one, or null if it's a wrapper too truncated to recover. A
// wrapper whose inner URL had characters swapped for "*" (listed in the
// part after "__;") is kept wrapped when it's complete -- it still
// redirects fine -- rather than guessing at the swap.
function unwrapUrl(url) {
  if (!url) return null;
  const cleaned = url.replace(/[.,;:)\]]+$/, "");
  if (!/^https?:\/\/urldefense(?:\.proofpoint)?\.com\//i.test(cleaned)) return cleaned;
  const match = URL_DEFENSE_RE.exec(cleaned);
  if (!match) return null;
  if (!match[1].includes("*")) return match[1];
  return /\$$/.test(url) ? url : null;
}

// Unwraps every Proofpoint link in a body in place (used before storing a
// synced email, so the stored copy is shorter and its links are the real
// ones). A wrapper too truncated to recover is left as it was.
function unwrapLinksInText(text) {
  return (text || "").replace(URL_RE, (url) => {
    const unwrapped = unwrapUrl(url);
    if (!unwrapped || unwrapped === url) return url;
    // Keep any trailing punctuation unwrapUrl trimmed off the original.
    const trailing = url.slice(url.replace(/[.,;:)\]]+$/, "").length);
    return unwrapped + (/^https?:\/\/urldefense/i.test(unwrapped) ? "" : trailing);
  });
}

// Swaps each link in a body for a short tag ([L1], [L2], ...) so Claude can
// point at one by tag instead of re-typing it -- returns the tagged text and
// the links in tag order (null for one too truncated to use). The same link
// appearing twice gets the same tag.
function tagLinks(text) {
  const links = [];
  const index = new Map();
  const tagged = (text || "").replace(/<(https?:\/\/[^>\s]+)>?|https?:\/\/[^\s<>"]+/g, (whole, bracketed) => {
    const raw = bracketed || whole;
    const url = unwrapUrl(raw);
    const key = url || raw;
    if (!index.has(key)) {
      links.push(url);
      index.set(key, links.length);
    }
    return ` [L${index.get(key)}]`;
  });
  return { text: tagged, links };
}

// Resolves a tag Claude returned ("L3", "[L3]", 3) back to its link, or null.
function linkForTag(links, tag) {
  const match = /(\d+)/.exec(String(tag == null ? "" : tag));
  if (!match) return null;
  const url = links[Number(match[1]) - 1];
  return url && /^https?:\/\//i.test(url) ? url.slice(0, 2000) : null;
}

module.exports = { unwrapUrl, unwrapLinksInText, tagLinks, linkForTag };
