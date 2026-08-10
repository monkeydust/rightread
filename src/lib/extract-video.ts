/**
 * YouTube links: build a real item instead of failing.
 *
 * A watch page is a JavaScript shell with no article in it, so Readability
 * rightly finds nothing — production's YouTube item was stored as title
 * "m.youtube.com", error "No readable article found". But the failure wasted
 * metadata that YouTube hands out freely; a video link deserves a card that
 * says what the video is, not an apology.
 *
 * Two sources, in order of trust:
 *
 *  1. oEmbed (youtube.com/oembed) — documented, keyless, stable JSON. Title,
 *     channel, thumbnail. If this succeeds we have an item worth keeping.
 *  2. The watch page itself — undocumented ytInitialPlayerResponse JSON,
 *     scraped for description, duration, channel and date. Best-effort
 *     enrichment only: any shape change degrades to the oEmbed card, never to
 *     a failure.
 *
 * The result flows through the NORMAL pipeline (persistArticle): sanitised
 * like any other content, classified (the URL rule already maps YouTube to
 * "other"/video territory), embedded from the description so search and the
 * graph see it, and linked prominently to the video itself.
 */

import { JSDOM } from "jsdom";
import { safeFetch } from "@/lib/extract";
import type { Extracted } from "@/lib/extract";
import { sanitizeArticleHtml } from "@/lib/sanitize";

/** Hosts that mean "this is a YouTube video page". */
const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/**
 * The watch URL's video id, or null when the URL is not a video page.
 * Channel pages, playlists and search results are not videos and fall through
 * to normal extraction (which will fail, as before — that is correct: there is
 * no single video to describe).
 */
export function youtubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!YT_HOSTS.has(u.hostname)) return null;

  // youtu.be/<id>
  if (u.hostname === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return /^[\w-]{6,20}$/.test(id) ? id : null;
  }
  // /watch?v=<id>
  const v = u.searchParams.get("v");
  if (v && /^[\w-]{6,20}$/.test(v)) return v;
  // /shorts/<id>, /live/<id>, /embed/<id>
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,20})/);
  return m ? m[1] : null;
}

type OEmbed = {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
};

type WatchMeta = {
  description: string | null;
  lengthSeconds: number | null;
  channel: string | null;
  publishDate: string | null;
  viewCount: number | null;
};

/**
 * Builds an Extracted for a YouTube video, or throws with a readable message
 * if even oEmbed fails (private/deleted video, or YouTube refusing us).
 */
export async function extractYouTube(url: string, videoId: string): Promise<Extracted> {
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;

  // ── 1. oEmbed: the part that must succeed ────────────────────────
  const { body } = await safeFetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
    { contentTypes: /json/i, accept: "application/json" }
  );
  let oembed: OEmbed;
  try {
    oembed = JSON.parse(body) as OEmbed;
  } catch {
    throw new Error("YouTube returned an unreadable response for this video");
  }
  if (!oembed.title) {
    throw new Error("This video is unavailable (private or removed?)");
  }

  // ── 2. Watch page: enrichment, never required ────────────────────
  const meta = await watchPageMeta(canonical);

  const description = meta.description?.trim() || null;
  const minutes = meta.lengthSeconds ? Math.round(meta.lengthSeconds / 60) : null;
  const channel = meta.channel ?? oembed.author_name ?? null;

  // The card body. Built from trusted scalars and the description; the
  // description is plain text from YouTube's JSON, escaped before being placed
  // in markup, and the whole thing still passes the sanitizer downstream.
  const facts: string[] = [];
  if (channel) facts.push(escapeHtml(channel));
  if (minutes) facts.push(`${minutes} min`);
  if (meta.publishDate) facts.push(escapeHtml(meta.publishDate.slice(0, 10)));
  if (meta.viewCount) facts.push(`${meta.viewCount.toLocaleString("en-GB")} views`);

  const paragraphs = description
    ? description
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
        .join("")
    : `<p>No description was published for this video.</p>`;

  const rawHtml =
    (oembed.thumbnail_url
      ? `<p><a href="${escapeAttr(canonical)}"><img src="${escapeAttr(oembed.thumbnail_url)}" alt="Video thumbnail"></a></p>`
      : "") +
    `<p><strong><a href="${escapeAttr(canonical)}">▶ Watch on YouTube</a></strong>${
      facts.length ? ` — ${facts.join(" · ")}` : ""
    }</p>` +
    paragraphs;

  // Everything above is escaped by hand, but hand-escaping is not the gate this
  // codebase trusts — the sanitizer is. The reader renders contentHtml with
  // dangerouslySetInnerHTML, so this passes through sanitizeArticleHtml exactly
  // like the fetch and paste paths do, and a mistake above becomes harmless.
  const dom = new JSDOM("");
  const contentHtml = sanitizeArticleHtml(dom.window, rawHtml, canonical);
  dom.window.close();

  const textContent = [oembed.title, channel, description ?? ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title: oembed.title.slice(0, 300),
    siteName: "YouTube",
    byline: channel ? channel.slice(0, 200) : null,
    excerpt: description
      ? description.replace(/\s+/g, " ").slice(0, 500)
      : `Video by ${channel ?? "unknown"}${minutes ? `, ${minutes} min` : ""}`,
    leadImage: oembed.thumbnail_url ?? null,
    contentHtml,
    textContent,
    wordCount: textContent ? textContent.split(" ").length : 0,
    resolvedUrl: canonical,
  };
}

/** Scrapes the watch page. Every field optional; any failure returns nulls. */
async function watchPageMeta(canonical: string): Promise<WatchMeta> {
  const none: WatchMeta = {
    description: null,
    lengthSeconds: null,
    channel: null,
    publishDate: null,
    viewCount: null,
  };
  try {
    const { body } = await safeFetch(canonical, {
      contentTypes: /html/i,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      // A watch page is ~1.5MB of mostly script; well within the default cap,
      // but stated so a future cap change keeps this working.
      maxBytes: 16 * 1024 * 1024,
    });

    // ytInitialPlayerResponse fields, matched individually rather than parsing
    // the whole JSON blob: the blob is megabytes, its shape shifts, and each
    // regex degrades independently — losing the view count must not lose the
    // description.
    const str = (re: RegExp): string | null => {
      const m = body.match(re);
      if (!m) return null;
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return null;
      }
    };
    const description = str(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    const channel = str(/"ownerChannelName":"((?:[^"\\]|\\.)*)"/);
    const lengthSeconds = body.match(/"lengthSeconds":"(\d+)"/);
    const publishDate = body.match(/"publishDate":"([^"]{4,40})"/);
    const viewCount = body.match(/"viewCount":"(\d+)"/);

    return {
      description,
      channel,
      lengthSeconds: lengthSeconds ? Number(lengthSeconds[1]) : null,
      publishDate: publishDate ? publishDate[1] : null,
      viewCount: viewCount ? Number(viewCount[1]) : null,
    };
  } catch {
    return none;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
