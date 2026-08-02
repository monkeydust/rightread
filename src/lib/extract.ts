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

/**
 * Fetches a URL for extraction.
 *
 * Capture requests are user-supplied URLs fetched by the server, so this is an
 * SSRF surface: we re-check the host on every redirect hop rather than trusting
 * the original, and refuse anything resolving to a private range.
 */
async function fetchArticle(url: string): Promise<{ html: string; finalUrl: string }> {
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
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
    if (!/text\/html|application\/xhtml/i.test(type)) {
      throw new Error(`Not an HTML page (${type.split(";")[0] || "unknown type"})`);
    }

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error("Page too large");

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error("Page too large");

    const html = new TextDecoder("utf-8").decode(buf);

    // A 200 that is really a redirect. Re-enters the loop so the destination
    // gets the same private-address check as any other hop.
    const bounce = findClientRedirect(html, current);
    if (bounce && bounce !== current) {
      current = bounce;
      continue;
    }

    return { html, finalUrl: current };
  }

  throw new Error("Too many redirects");
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
