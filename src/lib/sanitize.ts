import createDOMPurify, { type WindowLike } from "dompurify";
import type { DOMWindow } from "jsdom";

/**
 * Sanitizes extracted article HTML.
 *
 * The reader renders the result with dangerouslySetInnerHTML, so this runs
 * DOMPurify (audited, handles the mXSS cases a hand-rolled allowlist misses)
 * with a tight allowlist on top.
 */
const ALLOWED_TAGS = [
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite",
  "code", "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em",
  "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "section",
  "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
];

const ALLOWED_ATTR = [
  "href", "title", "src", "alt", "width", "height", "colspan", "rowspan",
  "scope", "datetime", "start", "reversed", "target", "rel", "loading",
  "decoding",
];

/**
 * Rewrites relative src/href to absolute against the article URL, so images and
 * links still resolve when the article is served from our own origin. Runs
 * before sanitizing; DOMPurify then validates the resulting scheme.
 */
function absolutizeUrls(doc: Document, baseUrl: string) {
  for (const el of doc.querySelectorAll("[src], [href]")) {
    for (const name of ["src", "href"]) {
      const raw = el.getAttribute(name);
      if (!raw) continue;
      try {
        el.setAttribute(name, new URL(raw, baseUrl).toString());
      } catch {
        // Unresolvable (e.g. "javascript:…") — leave it for DOMPurify to strip.
      }
    }
  }
}

/**
 * @param window  a jsdom window; DOMPurify needs a real DOM to work against
 * @param html    raw article HTML from Readability
 * @param baseUrl the article URL, used to absolutize relative references
 */
export function sanitizeArticleHtml(
  window: DOMWindow,
  html: string,
  baseUrl: string
): string {
  // jsdom's DOMWindow satisfies DOMPurify's WindowLike at runtime, but the two
  // type definitions are structurally independent.
  const purify = createDOMPurify(window as unknown as WindowLike);

  const staging = window.document.implementation.createHTMLDocument("article");
  staging.body.innerHTML = html;
  absolutizeUrls(staging, baseUrl);

  // External links open in a new tab and must not leak window.opener.
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    if (node.nodeName === "IMG") {
      node.setAttribute("loading", "lazy");
      node.setAttribute("decoding", "async");
    }
  });

  const clean = purify.sanitize(staging.body.innerHTML, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // data: URIs are the one non-http exception, and only for images.
    ALLOWED_URI_REGEXP:
      /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i,
    // DOMPurify runs ALLOWED_URI_REGEXP over the value of *every* allowed
    // attribute it does not already know to be non-URI (alt, title, …), and
    // the strict regexp above has no clause for plain values the way the
    // default's `[^a-z]` does. So <time datetime="2026-…"> lost its attribute.
    // Declaring it URI-safe is the narrow fix; a timestamp is not a URL.
    ADD_URI_SAFE_ATTR: ["datetime"],
    FORBID_TAGS: ["style", "form", "input", "button", "svg", "math"],
    FORBID_ATTR: ["style", "srcset", "formaction", "ping"],
    // DOMPurify allows data-* by default. They are dead weight in a reader,
    // and some CMSs stash kilobytes of JSON in them (Wikipedia's data-mw is
    // most of the page weight) — so drop them and keep the stored HTML small.
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  });

  purify.removeAllHooks();
  return clean;
}
