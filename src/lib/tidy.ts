import type { DOMWindow } from "jsdom";

/**
 * Structural cleanup of already-sanitized article HTML.
 *
 * Readability decides what the article *is*; it doesn't tidy how it's built.
 * What survives is typically wrapped in several attribute-less <div>s, salted
 * with empty <p>s and stray <span>s, and — on wiki-style sites — peppered with
 * "[edit]" links. Those are structural problems, so CSS can't fix them.
 *
 * Runs AFTER sanitizing, deliberately:
 *  - every remaining attribute is already allowlisted, so "has no attributes"
 *    is a reliable signal that an element is pure nesting;
 *  - this pass only ever removes or unwraps existing nodes, so it cannot
 *    reintroduce anything unsafe.
 */

/** Unwrapped when they carry no attributes — they're only nesting. */
const WRAPPER_TAGS = new Set(["div", "span", "section", "article"]);

/** Dropped when they contain no text and nothing visual. */
const PRUNABLE_TAGS = new Set([
  "p", "div", "span", "li", "figure", "blockquote", "section", "article",
  "h1", "h2", "h3", "h4", "h5", "h6", "em", "strong", "b", "i",
]);

/** Elements that are meaningful even with no text of their own. */
const VOID_BUT_MEANINGFUL = "img, br, hr, td, th, iframe, video, audio";

function isEmpty(el: Element): boolean {
  if (el.querySelector(VOID_BUT_MEANINGFUL)) return false;
  //   is a non-breaking space — visually blank, but not \s in JS regex.
  return el.textContent?.replace(/[\s ]+/g, "") === "";
}

/** Wiki-style per-section "[edit]" links, which are noise in a reader. */
function isEditLink(el: Element): boolean {
  if (el.tagName !== "A") return false;
  const text = el.textContent?.trim().toLowerCase() ?? "";
  return text === "edit" || text === "[edit]" || text === "edit source";
}

export function tidyArticleHtml(window: DOMWindow, html: string): string {
  const doc = window.document.implementation.createHTMLDocument("tidy");
  doc.body.innerHTML = html;

  // 1. Drop edit links before anything else — removing them empties the
  //    headings' trailing spans, which the prune pass then collects.
  for (const el of [...doc.body.querySelectorAll("a")]) {
    if (isEditLink(el)) el.remove();
  }

  // 2. Unwrap nesting-only elements, and 3. prune empties.
  //    Both cascade: unwrapping can expose a newly-empty parent, pruning can
  //    leave a wrapper with a single child. Iterate to a fixed point rather
  //    than guessing a pass count, with a ceiling so malformed input can't
  //    spin forever.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;

    for (const el of [...doc.body.querySelectorAll("*")]) {
      if (!el.isConnected) continue;
      const tag = el.tagName.toLowerCase();

      if (WRAPPER_TAGS.has(tag) && el.attributes.length === 0) {
        el.replaceWith(...el.childNodes);
        changed = true;
        continue;
      }

      if (PRUNABLE_TAGS.has(tag) && isEmpty(el)) {
        el.remove();
        changed = true;
      }
    }

    if (!changed) break;
  }

  // 4. Leading and trailing <br> just add stray blank lines.
  for (const el of [...doc.body.querySelectorAll("br")]) {
    const prev = el.previousSibling;
    const next = el.nextSibling;
    if (!prev || !next) el.remove();
  }

  return doc.body.innerHTML.trim();
}
