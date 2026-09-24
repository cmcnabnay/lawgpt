// Bundled with esbuild into public/editor-bundle.js (see package.json's
// "build:editor" script) and exposed as the global `LawgptEditor` -- this
// file is the only thing that imports TipTap/ProseMirror; lawgpt.html itself
// just calls `LawgptEditor.createEditor(mountEl, options)` and drives the
// returned Editor instance's own API (chain/commands/isActive/getHTML/...).
import { Editor, Node, mergeAttributes } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Highlight } from "@tiptap/extension-highlight";

// Inline styles that pasted content (from the chat pane, web pages, Word,
// etc.) carries along and that TextStyleKit would otherwise faithfully keep
// -- a foreign font, size, text color and background "highlight". Pasted
// text should take on the document's own default look instead; the user
// re-applies any of these deliberately via the toolbar.
const PASTE_STRIPPED_STYLES = ["font-family", "font-size", "color", "background", "background-color", "line-height"];
function stripPastedStyles(html){
  // Copy/paste within a ProseMirror editor (data-pm-slice) is the user's own
  // formatting -- keep it.
  if (html.includes("data-pm-slice")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.body.querySelectorAll("[style]").forEach(el => {
    PASTE_STRIPPED_STYLES.forEach(prop => el.style.removeProperty(prop));
    if (!el.getAttribute("style").trim()) el.removeAttribute("style");
  });
  doc.body.querySelectorAll("[bgcolor]").forEach(el => el.removeAttribute("bgcolor"));
  doc.body.querySelectorAll("font").forEach(el => el.replaceWith(...el.childNodes));
  return doc.body.innerHTML;
}

// A manually-inserted, atomic page-break marker. Replaces the old hand-built
// live pagination/reflow engine: instead of the editor auto-flowing content
// across fixed-size pages (the source of most of the old editor's bugs), the
// document is one continuous flow and the user drops these in explicitly.
// collectBlocks() (in lawgpt.html) recognizes `[data-page-break]` and turns
// it back into the same `{type:"pagebreak"}` block the compile pipeline
// already understood.
const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML(){
    return [{ tag: "div[data-page-break]" }];
  },
  renderHTML({ HTMLAttributes }){
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-page-break": "true",
      class: "page-break",
      contenteditable: "false",
    }), "Page Break"];
  },
  addCommands(){
    return {
      // insertContent() on a solitary atom node leaves a NodeSelection
      // selecting the node itself (the same as clicking an inserted image) --
      // typing right after inserting one would then type-over/replace it
      // instead of adding new content after it. StarterKit's trailingNode
      // extension would eventually add a paragraph after a trailing atom,
      // but only as a *separate* appendTransaction once this one is already
      // dispatched -- too late to put the selection there in this same
      // command -- so insert that following empty paragraph ourselves, in
      // the same insertContent call, and let ProseMirror place the
      // selection inside it (its normal behavior when a textblock is the
      // last node of the inserted content).
      insertPageBreak: () => ({ chain }) => chain()
        .insertContent([{ type: this.name }, { type: "paragraph" }])
        .run(),
    };
  },
});

export function createEditor(mountEl, options){
  options = options || {};
  return new Editor({
    element: mountEl,
    extensions: [
      StarterKit,
      TextAlign.configure({ types: ["paragraph", "heading", "listItem"] }),
      TextStyleKit,
      Subscript,
      Superscript,
      TableKit.configure({ table: { resizable: false } }),
      Highlight,
      Placeholder.configure({ placeholder: options.placeholder || "" }),
      PageBreak,
    ],
    content: options.content || "<p></p>",
    autofocus: false,
    editorProps: { transformPastedHTML: stripPastedStyles },
    editable: options.editable !== false,
    // TipTap's Editor constructor unconditionally does
    // `this.on("transaction", this.options.onTransaction)` (and the same for
    // update/selectionUpdate) with no truthiness check, so an omitted
    // callback isn't skipped -- it registers `undefined` as a literal
    // listener, which throws the next time that event fires. Default every
    // one of these to a no-op rather than leaving it undefined.
    onUpdate: options.onUpdate || (() => {}),
    onSelectionUpdate: options.onSelectionUpdate || (() => {}),
    onTransaction: options.onTransaction || (() => {}),
  });
}
