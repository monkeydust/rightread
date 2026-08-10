import { JSDOM, VirtualConsole } from "jsdom";
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { sanitizeArticleHtml } from "./sanitize";
import { tidyArticleHtml } from "./tidy";

export type Extracted = {
  title: string;
  siteName: string | null;
  byline: string | null;
  excerpt: string | null;
  leadImage: string | null;
  contentHtml: string;
  textContent: string;
  wordCount: number;
  resolvedUrl: string;
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 rightread/0.1";

const FETCH_TIMEOUT_MS = 20_000;

/**
 * Default ceiling, sized for an article page. Callers can raise it: a
 * full-content Atom feed carries every post a site has ever published and is
 * legitimately far larger than any single page — danluu.com's is several times
 * this, which silently made the site impossible to add as a source.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Finds a client-side redirect in a 200 response.
 *
 * Plenty of sites (GitHub Pages in particular) answer 200 with a page whose
 * only job is to bounce the browser elsewhere, so following HTTP 3xx alone
 * leaves you extracting a stub that says "Redirect". We honour <meta refresh>
 * with a short delay, and the very common `location.replace("…")` one-liner —
 * matched as text, since we never execute page scripts.
 */
function findClientRedirect(html: string, baseUrl: string): string | null {
  const head = html.slice(0, 4000);

  const meta = head.match(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*(\d+)\s*;\s*url=([^"'>\s]+)/i
  );
  if (meta && Number(meta[1]) <= 5) {
    try {
      return new URL(meta[2], baseUrl).toString();
    } catch {
      return null;
    }
  }

  const script = head.match(
    /(?:location\.replace|location\.href\s*=|location\.assign)\s*\(?\s*["'](https?:\/\/[^"']+)["']/i
  );
  if (script) {
    try {
      return new URL(script[1], baseUrl).toString();
    } catch {
      return null;
    }
  }

  return null;
}

/** Hosts that resolve to the machine itself or the local network. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "[::1]" || h === "::1") return true;
  if (h === "metadata.google.internal") return true;

  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a >= 224) return true;
  }
  return false;
}

export type SafeFetchOptions = {
  /**
   * Content types this caller can actually use; anything else throws rather
   * than being handed to a parser that expects something different.
   */
  contentTypes: RegExp;
  /** The Accept header to send. */
  accept: string;
  /**
   * Follow <meta refresh> / location.replace bounces inside 200 responses.
   * Only meaningful for HTML — a feed is never a client-side redirect page.
   */
  followClientRedirects?: boolean;
  /** Overrides the default size ceiling. Still bounded — never unlimited. */
  maxBytes?: number;
};

/**
 * Fetches a user-supplied URL server-side, safely.
 *
 * Every fetch of a URL the user (or a feed the user subscribed to) provided is
 * an SSRF surface: we re-check the host on every redirect hop rather than
 * trusting the original, and refuse anything resolving to a private range.
 * This is the single hardened front door — article extraction and feed
 * fetching both come through here so the protections cannot drift apart.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions
): Promise<{ body: string; finalUrl: string }> {
  let current = url;

  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http and https URLs can be fetched");
    }
    if (isPrivateHost(parsed.hostname)) {
      throw new Error("Refusing to fetch a private or local address");
    }

    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: opts.accept,
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect with no Location (${res.status})`);
      current = new URL(location, current).toString();
      continue;
    }

    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

    const type = res.headers.get("content-type") ?? "";
    if (!opts.contentTypes.test(type)) {
      throw new Error(`Unexpected content type (${type.split(";")[0] || "unknown type"})`);
    }

    const limit = opts.maxBytes ?? MAX_BYTES;
    const tooBig = (n: number) =>
      new Error(`Too large: ${Math.round(n / 1024 / 1024)}MB, limit ${Math.round(limit / 1024 / 1024)}MB`);

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > limit) throw tooBig(declared);

    const buf = await res.arrayBuffer();
    if (buf.byteLength > limit) throw tooBig(buf.byteLength);

    const body = new TextDecoder("utf-8").decode(buf);

    // A 200 that is really a redirect. Re-enters the loop so the destination
    // gets the same private-address check as any other hop.
    if (opts.followClientRedirects) {
      const bounce = findClientRedirect(body, current);
      if (bounce && bounce !== current) {
        current = bounce;
        continue;
      }
    }

    return { body, finalUrl: current };
  }

  throw new Error("Too many redirects");
}

/** Fetches a page for article extraction. */
async function fetchArticle(url: string): Promise<{ html: string; finalUrl: string }> {
  const { body, finalUrl } = await safeFetch(url, {
    contentTypes: /text\/html|application\/xhtml/i,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    followClientRedirects: true,
  });
  return { html: body, finalUrl };
}

function firstImage(doc: Document, baseUrl: string): string | null {
  const meta =
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content");
  const candidate = meta ?? doc.querySelector("article img")?.getAttribute("src");
  if (!candidate) return null;
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Fetches a URL and reduces it to clean, self-contained reader HTML.
 * Throws with a human-readable message when the page can't be turned into an
 * article — the caller stores that on the item as extractError.
 */
export async function extractArticle(url: string): Promise<Extracted> {
  const { html, finalUrl } = await fetchArticle(url);
  return extractFromHtml(html, finalUrl);
}

/**
 * Turns already-obtained HTML into clean reader content — the whole pipeline
 * after the fetch, so a fetch and a paste share one code path and one set of
 * guarantees.
 *
 * This is what makes the browser-sourced route safe: HTML pasted from the
 * user's own browser is arbitrary web content, exactly like HTML the server
 * fetched, and it passes through the identical sanitize gate (sanitizeArticleHtml)
 * before it is ever stored or rendered. The trust boundary does not move.
 *
 * `sourceUrl` is the page the HTML came from, used to resolve relative links
 * and as the base for og: lookups. For a paste it is the original article URL,
 * not the archive wrapper.
 */
export function extractFromHtml(html: string, sourceUrl: string): Extracted {
  const finalUrl = sourceUrl;

  // jsdom logs every CSS parse error on a real-world page otherwise.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  const dom = new JSDOM(html, { url: finalUrl, virtualConsole });
  const doc = dom.window.document;

  const siteName =
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content") ??
    null;
  const leadImage = firstImage(doc, finalUrl);

  const readerable = isProbablyReaderable(doc);
  // Readability mutates the document, so clone before parsing.
  const article = new Readability(doc.cloneNode(true) as Document, {
    charThreshold: readerable ? 500 : 100,
  }).parse();

  if (!article?.content) {
    dom.window.close();
    throw new Error("No readable article found on this page");
  }

  // Sanitize first (security gate), then tidy the structure it leaves behind.
  const contentHtml = tidyArticleHtml(
    dom.window,
    sanitizeArticleHtml(dom.window, article.content, finalUrl)
  );
  const textContent = (article.textContent ?? "").replace(/\s+/g, " ").trim();
  const wordCount = textContent ? textContent.split(" ").length : 0;

  const title =
    article.title?.trim() ||
    doc.querySelector("title")?.textContent?.trim() ||
    // A pasted selection often has no <title>, but its <h1> is a fine last
    // resort — far better than showing the bare hostname.
    doc.querySelector("h1")?.textContent?.trim() ||
    new URL(finalUrl).hostname;

  const result: Extracted = {
    title: title.slice(0, 300),
    siteName: (article.siteName ?? siteName)?.slice(0, 120) ?? null,
    byline: article.byline?.trim().slice(0, 200) ?? null,
    excerpt: article.excerpt?.trim().slice(0, 500) ?? null,
    leadImage,
    contentHtml,
    textContent,
    wordCount,
    resolvedUrl: finalUrl,
  };

  dom.window.close();
  return result;
}

/** ~200 wpm, the usual reading-time figure. Always at least 1. */
export function readingMinutes(wordCount: number | null | undefined): number {
  return Math.max(1, Math.round((wordCount ?? 0) / 200));
}
