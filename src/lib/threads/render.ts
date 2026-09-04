import { JSDOM } from "jsdom";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import type { Extracted } from "@/lib/extract";
import type { Thread, ThreadComment } from "./types";
import { RENDER_DEPTH_CAP } from "./hn";

/**
 * Turns a Thread into the same `Extracted` shape the fetch and paste paths
 * produce, so a thread flows through `persistArticle` like any other page:
 * classified, embedded, searchable, offline.
 *
 * Nesting is structural — nested <blockquote>s — because the sanitizer's
 * allow list has no class or style attribute, and `.prose-reader` already
 * draws a quote bar, so depth reads as indentation without a stylesheet the
 * reader would have to trust.
 *
 * Every scalar is escaped by hand and the whole document then goes through
 * sanitizeArticleHtml, the same gate the reader trusts for everything it
 * renders with dangerouslySetInnerHTML. The comment HTML is the site's own
 * markup and is treated as untrusted input, not as ours.
 */
export function renderThread(thread: Thread): Extracted {
  const head: string[] = [];
  if (thread.linkUrl) {
    head.push(
      `<p><strong><a href="${attr(thread.linkUrl)}">${esc(thread.title)} ↗</a></strong></p>`
    );
  }
  const facts: string[] = [];
  if (thread.points != null) facts.push(`${thread.points} points`);
  if (thread.author) facts.push(`by ${esc(thread.author)}`);
  facts.push(
    `<time datetime="${thread.createdAt.toISOString()}">${esc(shortDate(thread.createdAt))}</time>`
  );
  facts.push(`${thread.comments.length} comment${thread.comments.length === 1 ? "" : "s"}`);
  head.push(`<p><small>${facts.join(" · ")}</small></p>`);
  if (thread.bodyHtml) head.push(thread.bodyHtml);

  const body = head.join("") + (thread.comments.length ? "<hr>" + renderComments(thread.comments) : "");

  const dom = new JSDOM("");
  const contentHtml = sanitizeArticleHtml(dom.window, body, thread.url);
  dom.window.close();

  const textContent = [
    thread.title,
    thread.bodyText ?? "",
    ...thread.comments.map((c) => `${c.author ?? "[deleted]"}: ${c.text}`),
  ]
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  const firstText = thread.bodyText ?? thread.comments[0]?.text ?? "";

  return {
    title: thread.title,
    siteName: thread.siteName,
    byline: thread.author,
    excerpt: firstText ? firstText.slice(0, 200) : null,
    leadImage: null,
    contentHtml,
    textContent,
    wordCount: textContent ? textContent.split(/\s+/).length : 0,
    resolvedUrl: thread.url,
  };
}

/**
 * Comments arrive flat with a depth; rebuild the nesting as we go. A comment
 * deeper than the cap is emitted at the cap — still inside its parent's
 * quote, just not indented further.
 */
function renderComments(comments: ThreadComment[]): string {
  let out = "";
  let open = 0; // blockquotes currently open; a comment at depth d sits inside d
  for (const c of comments) {
    // Clamp to `open` as well: a depth that jumps past its parent (bad input)
    // renders as a sibling rather than opening quotes with nothing in them.
    const depth = Math.min(c.depth, RENDER_DEPTH_CAP, open);
    // Closes the previous comment's quote when this is a sibling, and every
    // deeper level when it is a reply higher up the tree.
    while (open > depth) {
      out += "</blockquote>";
      open--;
    }
    out += "<blockquote>";
    open++;
    out +=
      `<p><cite>${esc(c.author ?? "[deleted]")}</cite> · ` +
      `<time datetime="${c.createdAt.toISOString()}">${esc(shortDate(c.createdAt))}</time></p>` +
      c.html;
  }
  while (open > 0) {
    out += "</blockquote>";
    open--;
  }
  return out;
}

function shortDate(d: Date): string {
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attr(s: string): string {
  return esc(s).replace(/'/g, "&#39;");
}
