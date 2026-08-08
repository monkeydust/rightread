/**
 * Turning a site into a feed.
 *
 * "Add a listener" should mean pasting `lobste.rs`, not hunting for the feed
 * URL first. Sites already advertise their feeds — this reads the advert.
 *
 * Only the *finding* is new: fetching and parsing stay in feed.ts, so a
 * discovered feed goes through exactly the same SSRF-checked fetch and the
 * same parser as one typed in by hand.
 */

import { JSDOM } from "jsdom";
import { safeFetch } from "@/lib/extract";
import { fetchFeed, type ParsedFeed } from "./feed";

/** Feed types a <link rel="alternate"> may advertise. */
const FEED_TYPES = /^application\/(rss|atom)\+xml$|^application\/xml$|^text\/xml$/i;

/**
 * Conventional paths, tried in order when a page advertises nothing.
 *
 * Ordered by how common they are, because each one costs a request against a
 * site that has already shown it does not advertise a feed.
 */
const FALLBACK_PATHS = [
  "/feed",
  "/rss",
  "/index.xml",
  "/atom.xml",
  "/feed.xml",
  "/rss.xml",
  "/feed/",
];

export type Discovered = {
  feedUrl: string;
  feed: ParsedFeed;
  /** How it was found — surfaced in the UI so the result is explicable. */
  via: "direct" | "advertised" | "guessed";
};

/**
 * Finds a usable feed for whatever the user pasted.
 *
 * Order matters: the input is tried as a feed first, so someone who already
 * knows the feed URL pays exactly one request and gets the old behaviour.
 */
export async function discoverFeed(input: string): Promise<Discovered> {
  const url = normalise(input);

  // 1. It might already be a feed.
  try {
    const feed = await fetchFeed(url);
    return { feedUrl: url, feed, via: "direct" };
  } catch {
    // Not a feed, or not reachable as one. Fall through and treat it as a page.
  }

  // 2. Ask the page where its feed is.
  let advertised: string[] = [];
  try {
    const { body, finalUrl } = await safeFetch(url, {
      contentTypes: /html|xml|text\/plain/i,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      followClientRedirects: true,
    });
    advertised = feedLinks(body, finalUrl);
  } catch (err) {
    // A site we cannot even load is a clearer error than "no feed found".
    throw new Error(
      `Could not load ${url}: ${err instanceof Error ? err.message : "unreachable"}`
    );
  }

  for (const candidate of advertised) {
    try {
      const feed = await fetchFeed(candidate);
      return { feedUrl: candidate, feed, via: "advertised" };
    } catch {
      // Advertised but broken; try the next one before guessing.
    }
  }

  // 3. Guess at the conventional paths.
  const origin = new URL(url).origin;
  for (const path of FALLBACK_PATHS) {
    const candidate = `${origin}${path}`;
    try {
      const feed = await fetchFeed(candidate);
      return { feedUrl: candidate, feed, via: "guessed" };
    } catch {
      // Expected for most paths on most sites.
    }
  }

  throw new Error(
    `No RSS or Atom feed found for ${url}. The site may not publish one — ` +
      `if you know the feed address, paste that instead.`
  );
}

/** Bare hostnames are what people actually type. */
export function normalise(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a site or feed address");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  // Validate here rather than at the first fetch, so the error names the input.
  try {
    return new URL(withScheme).toString();
  } catch {
    throw new Error(`${input} is not a valid address`);
  }
}

/**
 * Feed URLs advertised by a page, most promising first.
 *
 * Exported for the tests, which run against HTML fixtures — discovery must be
 * checkable without reaching the network.
 */
export function feedLinks(html: string, baseUrl: string): string[] {
  const dom = new JSDOM(html);
  const links = [...dom.window.document.querySelectorAll("link[rel~='alternate' i][href]")];

  const scored = links
    .map((el) => {
      const type = el.getAttribute("type") ?? "";
      const href = el.getAttribute("href") ?? "";
      if (!href || !FEED_TYPES.test(type.trim())) return null;
      let resolved: string;
      try {
        // Feeds are routinely advertised relative ("/feed.xml").
        resolved = new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
      // An explicit rss/atom type beats a generic application/xml, which is
      // also used for sitemaps and other things that are not feeds.
      const specific = /rss|atom/i.test(type) ? 0 : 1;
      return { url: resolved, specific };
    })
    .filter((x): x is { url: string; specific: number } => x !== null)
    .sort((a, b) => a.specific - b.specific);

  // Same feed advertised twice (RSS and Atom types on one href) is common.
  return [...new Set(scored.map((s) => s.url))];
}
