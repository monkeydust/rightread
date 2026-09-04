import { JSDOM } from "jsdom";
import { safeFetch } from "@/lib/extract";
import type { ThreadAdapter, ThreadComment } from "./types";

/**
 * Hacker News, via the Algolia HN Search API.
 *
 * `hn.algolia.com/api/v1/items/<id>` returns the whole item as one JSON tree —
 * story fields plus `children` nested to any depth, each with author, time and
 * the comment HTML. No key, no rate-limit headroom to worry about at one fetch
 * per button press, and it is the same data the official Firebase API exposes
 * without the one-request-per-node walk that API would need.
 *
 * Only the numeric id from the user's URL is interpolated into the request, so
 * the fetched host is fixed; the SSRF checks in safeFetch still run, they just
 * have nothing to catch.
 */

const HN_HOSTS = new Set(["news.ycombinator.com"]);

/** The item id when the URL is an HN item page, else null. */
export function hnItemId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!HN_HOSTS.has(u.hostname)) return null;
  if (u.pathname !== "/item") return null;
  const id = u.searchParams.get("id");
  return id && /^\d{1,12}$/.test(id) ? id : null;
}

type AlgoliaItem = {
  id: number;
  created_at: string;
  type: "story" | "comment" | "poll" | "pollopt" | "job";
  author: string | null;
  title: string | null;
  url: string | null;
  text: string | null;
  points: number | null;
  children?: AlgoliaItem[];
};

/**
 * Deeper than this and the reader's nested quote bars eat the column on a
 * phone; a reply at depth 9 is rendered at depth 6, still under its parent.
 * The model sees the true depth — the cap is a rendering decision only.
 */
export const RENDER_DEPTH_CAP = 6;

export const hnAdapter: ThreadAdapter = {
  kind: "hn",
  match: hnItemId,

  async fetch(_url, id) {
    const { body } = await safeFetch(`https://hn.algolia.com/api/v1/items/${id}`, {
      contentTypes: /json/i,
      accept: "application/json",
      // A 3,000-comment megathread is a few MB of JSON; well under this.
      maxBytes: 20 * 1024 * 1024,
    });

    let item: AlgoliaItem;
    try {
      item = JSON.parse(body) as AlgoliaItem;
    } catch {
      throw new Error("Hacker News returned an unreadable response for this thread");
    }
    if (!item || typeof item.id !== "number") {
      throw new Error("That Hacker News item does not exist");
    }
    if (item.type === "comment") {
      // A permalink to one comment: summarising a branch as if it were the
      // thread would misdescribe both. Say so rather than guess.
      throw new Error("This link is to a single comment, not a thread");
    }

    const dom = new JSDOM("");
    const scratch = dom.window.document.createElement("div");
    const toText = (html: string | null): string => {
      if (!html) return "";
      // innerHTML on a detached jsdom element runs nothing; it is only a
      // parser here, and the HTML is sanitised separately before rendering.
      scratch.innerHTML = html.replace(/<p>/gi, "\n<p>");
      return (scratch.textContent ?? "").replace(/\s+/g, " ").trim();
    };

    const comments: ThreadComment[] = [];
    const walk = (nodes: AlgoliaItem[] | undefined, depth: number) => {
      for (const node of nodes ?? []) {
        const text = toText(node.text);
        // Deleted and dead comments come back with no author and no text but
        // often still have children. Keep the children where they are — the
        // reply is worth reading even when the thing it replied to is gone.
        if (text) {
          comments.push({
            id: String(node.id),
            author: node.author ?? null,
            createdAt: new Date(node.created_at),
            depth,
            text,
            html: node.text ?? "",
          });
          walk(node.children, depth + 1);
        } else {
          walk(node.children, depth);
        }
      }
    };
    walk(item.children, 0);
    dom.window.close();

    return {
      url: `https://news.ycombinator.com/item?id=${item.id}`,
      siteName: "Hacker News",
      title: item.title?.trim() || `Hacker News thread ${item.id}`,
      author: item.author ?? null,
      createdAt: new Date(item.created_at),
      points: typeof item.points === "number" ? item.points : null,
      linkUrl: item.url?.trim() || null,
      bodyHtml: item.text?.trim() || null,
      bodyText: toTextStandalone(item.text),
      comments,
      fetchedAt: new Date(),
    };
  },
};

function toTextStandalone(html: string | null): string | null {
  if (!html) return null;
  const dom = new JSDOM(`<div>${html}</div>`);
  const text = (dom.window.document.body.textContent ?? "").replace(/\s+/g, " ").trim();
  dom.window.close();
  return text || null;
}
