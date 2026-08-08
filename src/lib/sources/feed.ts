import { JSDOM, VirtualConsole } from "jsdom";
import { safeFetch } from "@/lib/extract";

export type FeedEntry = {
  url: string;
  title: string;
  /** Plain text, HTML stripped — feed summaries routinely contain markup. */
  excerpt: string | null;
  publishedAt: Date | null;
};

export type ParsedFeed = {
  title: string | null;
  siteUrl: string | null;
  entries: FeedEntry[];
};

/**
 * Fetches and parses an RSS or Atom feed.
 *
 * Hand-rolled over jsdom's XML parser rather than pulling in a feed library:
 * the two formats' useful subset is small, jsdom is already a dependency, and
 * the codebase deliberately avoids adding packages for parsing jobs it can do
 * with what's installed (see the sqlite-vec decision in search/embed.ts).
 *
 * Content-type is deliberately loose (`*xml*` plus text/plain and
 * octet-stream): real-world feeds are served under all of these, and the
 * parse step below is the actual validation.
 */
export async function fetchFeed(feedUrl: string): Promise<ParsedFeed> {
  const { body, finalUrl } = await safeFetch(feedUrl, {
    contentTypes: /xml|rss|atom|text\/plain|octet-stream/i,
    accept:
      "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
  });
  return parseFeed(body, finalUrl);
}

/** Parses RSS 2.0 / RSS 1.0 (RDF) / Atom. Throws when the input is neither. */
export function parseFeed(xml: string, baseUrl: string): ParsedFeed {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  // jsdom's XML parser throws saxes errors like "about:blank:1:22: unclosed
  // tag: body" on malformed input. That string ends up as lastError on the
  // sources list, where "unclosed tag" would read as our bug rather than
  // "that URL isn't a feed" — which is what it almost always means (someone
  // pasted the site's homepage instead of its feed).
  let dom: JSDOM;
  try {
    dom = new JSDOM(xml, { contentType: "text/xml", virtualConsole });
  } catch {
    throw new Error("Not valid XML — is this the feed URL, not the page URL?");
  }
  const doc = dom.window.document;

  try {
    // Some malformed input surfaces as a parsererror element instead.
    if (doc.querySelector("parsererror")) {
      throw new Error("Not valid XML — is this the feed URL, not the page URL?");
    }

    const root = doc.documentElement?.localName;
    if (root === "feed") return parseAtom(doc, baseUrl);
    if (root === "rss" || root === "RDF") return parseRss(doc, baseUrl);
    throw new Error(`Not an RSS or Atom feed (root element <${root ?? "?"}>)`);
  } finally {
    dom.window.close();
  }
}

/** Text content of the first matching child element, trimmed, or null. */
function childText(parent: Element, name: string): string | null {
  for (const el of parent.children) {
    if (el.localName === name) {
      const text = el.textContent?.trim();
      return text || null;
    }
  }
  return null;
}

/**
 * Feed summaries are frequently HTML (often CDATA-wrapped). Parse and take
 * textContent rather than regex-stripping — nested tags and entities make the
 * regex approach a losing game. The result is only ever displayed as text.
 */
function stripHtml(html: string): string {
  return JSDOM.fragment(html).textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function absolute(url: string | null, baseUrl: string): string | null {
  if (!url) return null;
  try {
    const abs = new URL(url, baseUrl);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;
    return abs.toString();
  } catch {
    return null;
  }
}

function parseRss(doc: Document, baseUrl: string): ParsedFeed {
  // getElementsByTagName matches qualified names, which covers both plain RSS
  // 2.0 and RSS 1.0's default-namespaced elements in practice.
  const channel = doc.getElementsByTagName("channel")[0] ?? null;

  const entries: FeedEntry[] = [];
  for (const item of Array.from(doc.getElementsByTagName("item"))) {
    const url = absolute(childText(item, "link"), baseUrl);
    if (!url) continue; // an item we cannot link to is useless to us

    const rawSummary =
      childText(item, "description") ?? childText(item, "encoded"); // content:encoded
    entries.push({
      url,
      title: childText(item, "title") ?? url,
      excerpt: rawSummary ? stripHtml(rawSummary).slice(0, 500) || null : null,
      publishedAt: parseDate(
        childText(item, "pubDate") ?? childText(item, "date") // dc:date (RSS 1.0)
      ),
    });
  }

  return {
    title: channel ? childText(channel, "title") : null,
    siteUrl: channel ? absolute(childText(channel, "link"), baseUrl) : null,
    entries,
  };
}

/** Atom's <link> is an attribute, and rel="alternate" (or no rel) is the page. */
function atomLink(parent: Element, baseUrl: string): string | null {
  let fallback: string | null = null;
  for (const el of parent.children) {
    if (el.localName !== "link") continue;
    const href = absolute(el.getAttribute("href"), baseUrl);
    if (!href) continue;
    const rel = el.getAttribute("rel");
    if (!rel || rel === "alternate") return href;
    fallback ??= href;
  }
  return fallback;
}

function parseAtom(doc: Document, baseUrl: string): ParsedFeed {
  const feed = doc.documentElement;

  const entries: FeedEntry[] = [];
  for (const entry of Array.from(doc.getElementsByTagName("entry"))) {
    const url = atomLink(entry, baseUrl);
    if (!url) continue;

    const rawSummary = childText(entry, "summary") ?? childText(entry, "content");
    entries.push({
      url,
      title: childText(entry, "title") ?? url,
      excerpt: rawSummary ? stripHtml(rawSummary).slice(0, 500) || null : null,
      publishedAt: parseDate(
        childText(entry, "published") ?? childText(entry, "updated")
      ),
    });
  }

  return {
    title: childText(feed, "title"),
    siteUrl: atomLink(feed, baseUrl),
    entries,
  };
}
