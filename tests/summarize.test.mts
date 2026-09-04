/**
 * Thread summaries — offline, against a captured HN API response.
 *
 * What these pin: that a thread is read as structure (every comment, in rank
 * order, with its depth), that the rendered thread survives the sanitizer with
 * its nesting intact, that the text budget prefers what is new, and that the
 * prompt asks for "since last time" exactly when there is a last time. Each is
 * a silent-mislabel failure rather than a crash, which is why they get tests.
 */

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { hnItemId, hnAdapter } from "../src/lib/threads/hn.ts";
import { renderThread } from "../src/lib/threads/render.ts";
import { threadAdapterFor } from "../src/lib/threads/index.ts";
import type { Thread, ThreadComment } from "../src/lib/threads/types.ts";
import { sanitizeArticleHtml } from "../src/lib/sanitize.ts";
import { threadText } from "../src/lib/summarize/thread.ts";
import { systemPromptFor, buildUserMessage } from "../src/lib/summarize/prompts.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

// ── URL matching ─────────────────────────────────────────────────
check("hnItemId: item page", hnItemId("https://news.ycombinator.com/item?id=49415852") === "49415852");
check("hnItemId: extra params", hnItemId("https://news.ycombinator.com/item?id=7&p=2") === "7");
check("hnItemId: front page is not a thread", hnItemId("https://news.ycombinator.com/") === null);
check("hnItemId: /newest is not a thread", hnItemId("https://news.ycombinator.com/newest") === null);
check("hnItemId: other host", hnItemId("https://example.com/item?id=1") === null);
check("hnItemId: non-numeric id", hnItemId("https://news.ycombinator.com/item?id=abc") === null);
check("threadAdapterFor: HN resolves", threadAdapterFor("https://news.ycombinator.com/item?id=1")?.adapter.kind === "hn");
check("threadAdapterFor: reddit has no adapter", threadAdapterFor("https://www.reddit.com/r/x/comments/abc/t/") === null);

// ── Parsing the fixture (no network: replay through the adapter's parser) ──
const fixture = JSON.parse(readFileSync(new URL("./fixtures/hn-49415852.json", import.meta.url), "utf8"));
// The adapter's fetch goes through safeFetch; drive the parse by stubbing fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify(fixture), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
let thread: Thread;
try {
  thread = await hnAdapter.fetch("https://news.ycombinator.com/item?id=49415852", "49415852");
} finally {
  globalThis.fetch = realFetch;
}

check("parse: title", thread.title === "OCR It – pull text out of un-copyable documents for your LLM");
check("parse: 24 comments with text", thread.comments.length === 24, `got ${thread.comments.length}`);
check("parse: link post recorded", thread.linkUrl === "https://github.com/thiagotigaz/ocr-it");
check("parse: points", thread.points === 140);
check("parse: first comment is depth 0", thread.comments[0]?.depth === 0);
check("parse: max depth 3 (4 levels)", Math.max(...thread.comments.map((c) => c.depth)) === 3);
check("parse: entities decoded in text", thread.comments.some((c) => c.text.includes("can't")) && !thread.comments.some((c) => c.text.includes("&#x27;")));
check("parse: every comment has an author and a date", thread.comments.every((c) => c.author && !Number.isNaN(c.createdAt.getTime())));
{
  // Depth-first: a comment's children follow it before the next sibling.
  const first = fixture.children[0];
  const firstSubtree = (function count(n: { children?: unknown[] }): number {
    return 1 + ((n.children ?? []) as { children?: unknown[] }[]).reduce((a, c) => a + count(c), 0);
  })(first);
  const secondTopIdx = thread.comments.findIndex((c, i) => i > 0 && c.depth === 0);
  check("parse: tree order is depth-first", secondTopIdx === firstSubtree, `second top-level at ${secondTopIdx}, expected ${firstSubtree}`);
}

// ── Rendering ────────────────────────────────────────────────────
const rendered = renderThread(thread);
check("render: has a body", rendered.contentHtml.length > 1000);
check("render: one <cite> per comment", (rendered.contentHtml.match(/<cite>/g) ?? []).length === 24);
check("render: datetime preserved", /<time datetime="2026-/.test(rendered.contentHtml));
check("render: wordCount counts comments", rendered.wordCount > 500, `got ${rendered.wordCount}`);
check("render: excerpt from first comment when no body", !!rendered.excerpt && thread.comments[0].text.startsWith(rendered.excerpt.slice(0, 40)));
check("render: resolvedUrl is canonical", rendered.resolvedUrl === "https://news.ycombinator.com/item?id=49415852");
{
  // Re-sanitising the sanitised output must be a no-op: nothing in it is
  // something the gate would remove.
  const dom = new JSDOM("");
  const again = sanitizeArticleHtml(dom.window, rendered.contentHtml, thread.url);
  dom.window.close();
  check("render: idempotent under the sanitizer", again === rendered.contentHtml);
}
{
  // Nesting: a depth-1 comment sits inside its parent's blockquote.
  const dom = new JSDOM(rendered.contentHtml);
  const quotes = [...dom.window.document.querySelectorAll("blockquote")];
  const nested = quotes.filter((q) => q.parentElement?.tagName === "BLOCKQUOTE");
  const depth1 = thread.comments.filter((c) => c.depth >= 1).length;
  check("render: replies are nested inside their parents", nested.length === depth1, `${nested.length} nested vs ${depth1} replies`);
  dom.window.close();
}
{
  // Depth cap: depth 9 renders at 6, still inside its chain.
  const deep: ThreadComment[] = Array.from({ length: 10 }, (_, i) => ({
    id: `d${i}`, author: `u${i}`, createdAt: new Date("2026-01-01"), depth: i, text: `reply ${i}`, html: `<p>reply ${i}</p>`,
  }));
  const out = renderThread({ ...thread, comments: deep, bodyHtml: null, bodyText: null, linkUrl: null });
  const dom = new JSDOM(out.contentHtml);
  let maxDepth = 0;
  for (const q of dom.window.document.querySelectorAll("blockquote")) {
    let d = 0, p: Element | null = q;
    while ((p = p.parentElement) && p.tagName === "BLOCKQUOTE") d++;
    maxDepth = Math.max(maxDepth, d);
  }
  check("render: nesting capped at 6", maxDepth === 6, `max nested depth ${maxDepth}`);
  check("render: capped comments still all present", (out.contentHtml.match(/<cite>/g) ?? []).length === 10);
  dom.window.close();
}
{
  // Malicious comment HTML never reaches the reader.
  const evil: ThreadComment = { id: "x", author: "mallory", createdAt: new Date(), depth: 0, text: "hi", html: `<p>hi<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a></p>` };
  const out = renderThread({ ...thread, comments: [evil] });
  check("render: comment HTML is sanitised", !/onerror|<script|javascript:/i.test(out.contentHtml));
}

// ── Budgeting ────────────────────────────────────────────────────
{
  const full = threadText(thread);
  check("threadText: everything fits at default budget", full.included === 24 && full.commentCount === 24);
  check("threadText: no NEW marks without a since", !full.text.includes("· NEW]") && full.newComments === 0);
  check("threadText: depth is labelled", /\[\S+ · depth 0\]/.test(full.text));
  check("threadText: link post mentioned", full.text.includes("Post links to: https://github.com/thiagotigaz/ocr-it"));
}
{
  // Mark the last 6 comments (by time) as new; squeeze the budget so only a
  // few survive; every survivor that is new must precede any that is not.
  const byTime = [...thread.comments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const since = new Date(byTime[byTime.length - 7].createdAt.getTime());
  const tight = threadText(thread, since, 2_500);
  const lines = tight.text.split("\n").filter((l) => l.startsWith("["));
  check("threadText: counts new comments", tight.newComments === 6, `got ${tight.newComments}`);
  check("threadText: budget respected", tight.text.length <= 2_500 + 200, `len ${tight.text.length}`);
  check("threadText: something was omitted", tight.included < 24 && tight.text.includes("omitted for length"));
  const newLines = lines.filter((l) => l.includes("· NEW]")).length;
  check("threadText: new comments survive a tight budget", newLines >= 2, `${newLines} new lines kept of ${lines.length}`);
}
{
  // Rank order is preserved in the output even though selection preferred new.
  const since = new Date(0);
  const out = threadText(thread, since);
  const ids = out.text.split("\n").filter((l) => l.startsWith("[")).map((l) => l.slice(1, l.indexOf(" ")));
  const order = thread.comments.map((c) => c.author);
  check("threadText: output keeps rank order", JSON.stringify(ids) === JSON.stringify(order.slice(0, ids.length)));
  check("threadText: all new when since is epoch", out.newComments === 24);
}

// ── Prompt shape ─────────────────────────────────────────────────
{
  const base = { kind: "conversation", title: "T", url: "https://x", text: "words ".repeat(100) };
  const noPrev = buildUserMessage(base);
  check("prompt: no previous block without previous", !noPrev.includes("Previous summary"));
  check("prompt: sinceLast not requested without previous", !systemPromptFor("conversation", null).includes("sinceLast"));
  const prev = { createdAt: new Date("2026-09-01"), fetchedAt: new Date("2026-09-01"), tldr: "old tldr", points: ["p1"], verdict: "v", commentCount: 10 };
  const withPrev = buildUserMessage({ ...base, previous: prev });
  check("prompt: previous block present", withPrev.includes("Previous summary (written 2026-09-01, when the thread had 10 comments):") && withPrev.includes("old tldr"));
  check("prompt: sinceLast requested with previous", systemPromptFor("conversation", prev).includes("sinceLast"));
  check("prompt: conversation asks for standout and links", systemPromptFor("conversation").includes('"standout"') && systemPromptFor("conversation").includes('"links"'));
  check("prompt: blog does not", !systemPromptFor("blog").includes("standout"));
  const clipped = buildUserMessage({ ...base, text: "x".repeat(50_000), maxChars: 60_000 });
  check("prompt: maxChars override lifts the prose ceiling", !clipped.includes("truncated"));
}

console.log(failed === 0 ? "\nAll summarize checks pass." : `\n${failed} FAILING`);
process.exit(failed === 0 ? 0 : 1);
