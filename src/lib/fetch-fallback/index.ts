import { JSDOM } from "jsdom";
import {
  BlockedError,
  extractFromHtml,
  extractWholeFromHtml,
  type Extracted,
} from "../extract";
import { fetchPage, FallbackError, type FallbackPage, type FetchImpl } from "./tinyfish";

export { FallbackError } from "./tinyfish";

/**
 * The fetch fallback: a second way to read a page whose site refuses this
 * server.
 *
 * Some sites answer every request from a datacentre address with a bot wall
 * (Mumsnet's Cloudflare is the case this was built for), so a save from the
 * phone's share sheet arrives as a failed row for a page the user was reading
 * a second earlier. When — and only when — our own fetch failed that way, the
 * URL is handed to TinyFish's Fetch API, which returns the page's content as
 * HTML, and the item is built from that instead.
 *
 * What to keep in mind when changing this:
 *
 *  - **It is opt-in and off by default.** No `TINYFISH_API_KEY`, no call, and
 *    behaviour is exactly what it was before this module existed.
 *  - **It sends the URL of the blocked page to a third party.** Nothing else
 *    leaves: no cookies, no user id, no other item. That is why the trigger
 *    is as narrow as it is — a 404 or a timeout tells TinyFish nothing.
 *  - **What comes back is untrusted.** It is another company's rendering of
 *    somebody else's page. It goes through `sanitizeArticleHtml` like every
 *    other HTML the reader shows, and `final_url` is only believed when it
 *    stays on the host we asked for.
 *  - **A forum thread is many pages.** They are fetched one at a time, with a
 *    pause, and joined into one item. One at a time is deliberate: TinyFish
 *    will take ten URLs in a batch and fetch them in parallel, which from the
 *    origin's side is a burst from a tool it has already said it does not
 *    want. A reader turning pages is the pace to imitate.
 */

/** Pages joined into one item before the thread is cut short. */
export const MAX_PAGES = 40;

/** Raw HTML across all pages. A 40-page thread is well under this. */
const MAX_TOTAL_CHARS = 4_000_000;

/** Wall-clock budget for one save, pauses included. */
const DEADLINE_MS = 150_000;

/** Between page requests. */
const PAUSE_MS = 1_500;

/** Query parameters that mean "which page of this thread". */
const PAGE_PARAMS = ["page", "pg", "paged"];

export type FallbackDeps = {
  apiKey?: string | null;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** The configured key, or null. Blank counts as unset (Compose passes ""). */
export function fallbackKey(): string | null {
  return process.env.TINYFISH_API_KEY?.trim() || null;
}

/**
 * The trigger, in one place: our own fetch was refused by a bot wall, and a
 * key is configured. Not a 404, not a timeout, not a page that fetched and
 * held no article — those are answers, and a second fetcher would get the
 * same one.
 */
export function shouldUseFallback(err: unknown, apiKey: string | null = fallbackKey()): boolean {
  return err instanceof BlockedError && Boolean(apiKey);
}

function sameHost(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return strip(a) === strip(b);
}

function samePath(a: string, b: string): boolean {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return strip(a) === strip(b);
}

/** The page number a URL asks for, or null when it names none. */
function pageParam(u: URL): number | null {
  for (const name of PAGE_PARAMS) {
    const raw = u.searchParams.get(name);
    if (raw && /^\d{1,5}$/.test(raw)) return Number(raw);
  }
  return null;
}

/**
 * The next page of the same thread, or null at the end.
 *
 * Deliberately strict: the link must be on the origin and path we started
 * from and differ only by naming page n+1. The list of links is whatever the page
 * (or the service) says it is, so "next" is never taken on trust — a link to
 * another thread, another site or an internal address cannot be followed
 * because it cannot satisfy this.
 */
export function nextPageUrl(page: FallbackPage, threadUrl: string): string | null {
  let base: URL;
  let asked: URL;
  try {
    base = new URL(threadUrl);
    asked = new URL(page.url);
  } catch {
    return null;
  }

  const current = pageParam(asked) ?? page.pageNumber ?? 1;
  if (page.pageTotal && current >= page.pageTotal) return null;

  // Same origin: scheme, host and port, not just a matching hostname. The one
  // allowance is where the site itself sent the first request — a redirect
  // from example.com to https://www.example.com is the same site, and its
  // links will all carry the second spelling. That is accepted only for an
  // https URL on the default port whose host differs by nothing but "www.".
  const origins = new Set([base.origin]);
  try {
    const landed = new URL(page.finalUrl);
    if (
      landed.protocol === "https:" &&
      landed.port === "" &&
      sameHost(landed.hostname, base.hostname)
    ) {
      origins.add(landed.origin);
    }
  } catch {
    // an unparseable final URL adds nothing
  }

  for (const link of page.links) {
    let candidate: URL;
    try {
      candidate = new URL(link);
    } catch {
      continue;
    }
    if (candidate.protocol !== "https:" && candidate.protocol !== "http:") continue;
    if (!origins.has(candidate.origin)) continue;
    if (!samePath(candidate.pathname, base.pathname)) continue;
    if (pageParam(candidate) !== current + 1) continue;
    candidate.hash = "";
    return candidate.toString();
  }
  return null;
}

/**
 * Interface strings that survive extraction as one-line paragraphs. Exact
 * matches only, after lowercasing — "Reply" as a whole paragraph is a button;
 * "Reply to that if you like" is a post.
 */
const CHROME_PHRASES = new Set([
  "flip",
  "thread gallery",
  "show quote history",
  "hide quote history",
  "swipe left for the next trending thread",
  "advertisement",
  "watch thread",
  "watch this thread",
  "save thread",
  "add message",
  "add a message",
  "add post",
  "reply",
  "quote",
  "report",
  "share",
  "bookmark",
  "next",
  "previous",
  "back to top",
  "skip to main content",
  "more",
  "see all",
  "sign in",
  "log in",
  "register",
]);

/** "Please [create an account] or [log in] to access all these features". */
const CHROME_PATTERNS = [
  /^please\b.{0,60}\bto (?:access|use|see|view)\b.{0,60}$/i,
  /^(?:log ?in|sign ?in|sign ?up|register|create an account)\b.{0,40}\bto (?:post|reply|comment|continue|join)\b.{0,40}$/i,
  /^page \d+ of \d+$/i,
];

/** "Someone · 13/11/2026 09:41" — the line that opens a forum post. */
const POST_HEADER = /^(.{1,60}?) · (\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2})$/;

const LEAF_BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, div";

function norm(text: string | null | undefined): string {
  return (text ?? "").replace(/[\s ]+/g, " ").trim();
}

/**
 * Removes site interface from each page and marks post headers, returning
 * the pages' bodies as HTML in the same order.
 *
 * Three generic rules, no per-site selectors (classes are gone by the time
 * the HTML reaches us anyway):
 *
 *  1. Elements that are never content — templates, buttons, forms, nav.
 *  2. One-line blocks that are a known interface string.
 *  3. In a thread of three or more pages, a short block that appears on
 *     (nearly) every page. Interface repeats on every page by construction;
 *     a real reply saying "Thanks!" does not. The first page keeps its
 *     headings, so the thread's own title is not lost to this rule.
 *
 * This works on untrusted HTML but only ever removes nodes or wraps text in
 * <strong>, and the result still goes through the sanitizer.
 */
export function cleanPages(pagesHtml: string[]): string[] {
  const dom = new JSDOM("");
  try {
    const docs = pagesHtml.map((html) => {
      const doc = dom.window.document.implementation.createHTMLDocument("page");
      doc.body.innerHTML = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
      for (const el of [
        ...doc.body.querySelectorAll(
          "script, style, noscript, template, nav, form, button, select, textarea, input, svg, dialog, iframe"
        ),
      ]) {
        el.remove();
      }
      return doc;
    });

    const leaves = (doc: Document) =>
      [...doc.body.querySelectorAll(LEAF_BLOCKS)].filter(
        (el) => !el.querySelector(LEAF_BLOCKS)
      );

    // Rule 3: count the pages each short line appears on.
    const repeated = new Set<string>();
    if (docs.length >= 3) {
      const pagesWith = new Map<string, number>();
      for (const doc of docs) {
        const onThisPage = new Set<string>();
        for (const el of leaves(doc)) {
          const text = norm(el.textContent).toLowerCase();
          if (text && text.length <= 80 && !POST_HEADER.test(norm(el.textContent))) {
            onThisPage.add(text);
          }
        }
        for (const text of onThisPage) pagesWith.set(text, (pagesWith.get(text) ?? 0) + 1);
      }
      const threshold = Math.ceil(docs.length * 0.9);
      for (const [text, count] of pagesWith) {
        if (count >= threshold) repeated.add(text);
      }
    }

    docs.forEach((doc, index) => {
      for (const el of leaves(doc)) {
        const text = norm(el.textContent);
        const lower = text.toLowerCase();
        if (!text) continue;

        if (CHROME_PHRASES.has(lower) || CHROME_PATTERNS.some((re) => re.test(text))) {
          el.remove();
          continue;
        }

        if (repeated.has(lower)) {
          const firstPageHeading = index === 0 && /^H[1-6]$/.test(el.tagName);
          if (!firstPageHeading) {
            el.remove();
            continue;
          }
        }

        // Make the author stand out from the post beneath it. Only when the
        // line is plain text, so nothing structural is flattened.
        const header = text.match(POST_HEADER);
        if (header && el.tagName === "P" && el.children.length === 0) {
          el.textContent = "";
          const strong = doc.createElement("strong");
          strong.textContent = header[1];
          el.append(strong, doc.createTextNode(` · ${header[2]}`));
        }
      }
    });

    return docs.map((doc) => doc.body.innerHTML);
  } finally {
    dom.window.close();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Truncation = "pages" | "size" | "time" | "error" | null;

function truncationNote(reason: Truncation, saved: number, total: number | null): string {
  if (!reason) return "";
  const of = total && total > saved ? ` of ${total}` : "";
  const why =
    reason === "pages"
      ? `rightread saves at most ${MAX_PAGES} pages of a thread`
      : reason === "size"
        ? "the thread is too large to save whole"
        : reason === "time"
          ? "fetching the rest took too long"
          : "a later page could not be fetched";
  return (
    `<p><em>This thread is cut short: the first ${saved}${of} ` +
    `${saved === 1 ? "page is" : "pages are"} saved here, because ${why}. ` +
    `Open the original for the rest.</em></p>`
  );
}

/**
 * Fetches `url` through the fallback and returns it as an article ready for
 * `persistArticle`. Follows a paginated thread to its end (or to a cap).
 *
 * Throws `FallbackError` when the first page cannot be had. A failure on a
 * later page is not a failure of the save: the pages already fetched are
 * kept and the item says it is cut short.
 */
export async function fetchViaFallback(url: string, deps: FallbackDeps = {}): Promise<Extracted> {
  const apiKey = deps.apiKey === undefined ? fallbackKey() : deps.apiKey?.trim() || null;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "invalid-url";
    }
  })();

  // No key, no call. Checked here as well as in shouldUseFallback so that no
  // caller can reach the network by forgetting to ask first.
  if (!apiKey) throw new FallbackError("not_configured");

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const started = now();

  const pages: FallbackPage[] = [];
  let truncated: Truncation = null;

  try {
    let page = await fetchPage(url, apiKey, deps.fetchImpl);
    pages.push(page);
    let totalChars = page.html.length;
    const seen = new Set([url]);

    for (;;) {
      const next = nextPageUrl(page, url);
      if (!next || seen.has(next)) break;
      if (pages.length >= MAX_PAGES) {
        truncated = "pages";
        break;
      }
      if (totalChars >= MAX_TOTAL_CHARS) {
        truncated = "size";
        break;
      }
      if (now() - started >= DEADLINE_MS) {
        truncated = "time";
        break;
      }

      await sleep(PAUSE_MS);
      try {
        page = await fetchPage(next, apiKey, deps.fetchImpl);
      } catch {
        truncated = "error";
        break;
      }
      seen.add(next);
      pages.push(page);
      totalChars += page.html.length;
    }

    const article = buildArticle(url, pages, truncated);
    console.log(
      `[rightread] fetch fallback (tinyfish) host=${host} pages=${pages.length} ` +
        `outcome=${truncated ? `truncated:${truncated}` : "ok"}`
    );
    return article;
  } catch (err) {
    const code = err instanceof FallbackError ? err.code : "unusable_content";
    console.warn(
      `[rightread] fetch fallback (tinyfish) host=${host} pages=${pages.length} outcome=error:${code}`
    );
    throw err instanceof FallbackError ? err : new FallbackError(code);
  }
}

/**
 * Pages in, one article out.
 *
 * A single page that Readability reads almost whole is an ordinary article
 * that happened to be blocked, and gets the ordinary treatment. Anything
 * else — several pages, or one page Readability would cut down — is a
 * discussion, and is kept whole: every post, in order.
 */
function buildArticle(url: string, pages: FallbackPage[], truncated: Truncation): Extracted {
  const first = pages[0];

  // Believe the reported final URL only when it stays where we sent it.
  let sourceUrl = url;
  try {
    const final = new URL(first.finalUrl);
    if (/^https?:$/.test(final.protocol) && sameHost(final.hostname, new URL(url).hostname)) {
      sourceUrl = final.toString();
    }
  } catch {
    // keep the URL we asked for
  }

  const bodies = cleanPages(pages.map((p) => p.html));
  const note = truncationNote(truncated, pages.length, first.pageTotal);
  const joined = note + bodies.join("\n");
  const titleTag = first.title ? `<title>${escapeHtml(first.title)}</title>` : "";
  const documentHtml = `<!doctype html><html><head>${titleTag}</head><body>${joined}</body></html>`;

  const whole = extractWholeFromHtml(documentHtml, sourceUrl);
  let article = whole;

  if (pages.length === 1 && !truncated) {
    try {
      const read = extractFromHtml(documentHtml, sourceUrl);
      if (read.wordCount >= whole.wordCount * 0.7) article = read;
    } catch {
      // Readability found no article; the whole page is the answer.
    }
  }

  return {
    ...article,
    title: (first.title ?? article.title).slice(0, 300),
    siteName: (first.siteName ?? article.siteName)?.slice(0, 120) ?? null,
    byline: (first.author ?? article.byline)?.slice(0, 200) ?? null,
    excerpt: (first.description ?? article.excerpt)?.slice(0, 500) ?? null,
    leadImage: article.leadImage ?? safeImageUrl(first.leadImage),
    resolvedUrl: sourceUrl,
  };
}

/** `leadImage` is rendered as an <img src>, so only a plain web URL will do. */
function safeImageUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
