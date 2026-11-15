/**
 * The whole outside world, as far as the app under test can tell.
 *
 * One process, answering on port 80 (http) and 443 (https, with a certificate
 * `run.sh` makes for this run). It is reached under several names on the
 * test's own Docker network, and behaves by the name it was called:
 *
 *   news.e2e.test           pages to save. Each path has a mode (below).
 *   forum.e2e.test          a forum behind a bot wall: every request gets a
 *                           Cloudflare-style 403.
 *   api.fetch.tinyfish.ai   a fake of TinyFish's Fetch API, answering in the
 *                           shape recorded from the real one on 2026-11-13.
 *   openrouter.ai           always 503, so classification and embeddings
 *                           fail soft exactly as they would with a bad key.
 *   control.e2e.test        the tests' own handle: set a page's mode, release
 *                           a held page, read what was requested.
 *
 * Every poster, post and article here is invented.
 *
 * No dependencies: node's own http, https and fs.
 */

import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync } from "node:fs";

const TINYFISH_HOST = "api.fetch.tinyfish.ai";
const THREAD_PAGES = 3;

/**
 * Modes a page on news.e2e.test can be in:
 *   ok     the article
 *   error  HTTP 500
 *   wall   a Cloudflare-style 403
 *   hold   say nothing until released (then the article)
 * The default comes from the first path segment, so a test picks the starting
 * behaviour by the URL it saves and changes it later through the control host.
 */
const DEFAULT_MODE = { articles: "ok", flaky: "error", slow: "hold", walled: "wall" };
const modes = new Map();
const held = new Map(); // path -> [() => void]
const hits = []; // { host, method, path, apiKey?, urls? }

function modeOf(path) {
  return modes.get(path) ?? DEFAULT_MODE[path.split("/")[1]] ?? "missing";
}

function titleOf(path) {
  const slug = path.split("/").filter(Boolean).pop() ?? "untitled";
  const words = slug.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Long enough, and article-shaped enough, for Readability to take it whole. */
function articleHtml(path) {
  const title = titleOf(path);
  const marker = `Marker sentence for ${path}.`;
  const paragraphs = [
    marker,
    "The harbour at Low Fennick empties twice a day, and for an hour the boats sit on the mud like dropped toys. Children walk out between them to look for crabs, and the harbour master rings a bell when the water turns.",
    "Nobody in the village agrees on when the bell was first hung. The oldest account is a line in a ledger, written by a clerk who was mostly interested in the price of rope, and it says only that the bell was paid for in herring.",
    "What everybody does agree on is the sound. It carries across the flats further than a voice, and it has brought in more than one walker who had stopped to watch the birds and forgotten the sea behind them.",
    "The tide table pinned to the lifeboat station door is printed a year ahead. It is right to the minute in calm weather, and the crew will tell you that it has never once been right in a gale.",
    "In the spring the channel moves. A sandbank that sat to the north of the marker posts all winter is found one morning to the south of them, and the first boat out takes the long way round until somebody has walked it at low water.",
    "This is an invented place, written for a test. If you are reading it in the reader view of the app, the extraction worked.",
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} | The Fennick Gazette</title>
<meta property="og:site_name" content="The Fennick Gazette">
<meta name="author" content="Rowan Ashdown">
</head>
<body>
<header><nav><a href="/">Home</a> <a href="/articles/">Articles</a></nav></header>
<main>
<article>
<h1>${title}</h1>
<p class="byline">By Rowan Ashdown</p>
${paragraphs.map((p) => `<p>${p}</p>`).join("\n")}
</article>
</main>
<footer><p>The Fennick Gazette is not a real newspaper.</p></footer>
</body>
</html>`;
}

function wall(res) {
  res.writeHead(403, {
    "content-type": "text/html; charset=utf-8",
    "cf-mitigated": "challenge",
    server: "cloudflare",
  });
  res.end(
    "<!doctype html><html><head><title>Just a moment...</title></head>" +
      '<body><div id="cf-error-details">Performing security verification</div></body></html>'
  );
}

function sendArticle(res, path) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(articleHtml(path));
}

function news(req, res, path) {
  const mode = modeOf(path);
  if (mode === "ok") return sendArticle(res, path);
  if (mode === "wall") return wall(res);
  if (mode === "error") {
    res.writeHead(500, { "content-type": "text/plain" });
    return void res.end("fixture: this page is set to fail");
  }
  if (mode === "hold") {
    const waiting = held.get(path) ?? [];
    waiting.push(() => sendArticle(res, path));
    held.set(path, waiting);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("fixture: no such page");
}

// ── The forum, as the fake TinyFish reports it ───────────────────────

const POSTERS = ["HeronOnTheWeir", "SaltmarshSue", "TwoKettles", "MrsBarnacle", "QuietTuesday", "LowTideLen"];

function threadPosts(slug, page) {
  const posts = [];
  for (let i = 0; i < 4; i++) {
    const n = (page - 1) * 4 + i + 1;
    const poster = POSTERS[(n - 1) % POSTERS.length];
    posts.push(
      `<div class="post"><p>${poster} · ${10 + n}/11/2026 09:${String(n).padStart(2, "0")}</p>` +
        `<p>Reply ${n} of the ${slug} thread, on page ${page}. ${
          n === 1
            ? "Does anyone else find the harbour bell is rung later every year? We nearly got cut off on the flats on Sunday."
            : "I walked out past the second marker post and the water was already in the channel behind me, so I would not trust the printed table in this wind."
        }</p></div>`
    );
  }
  return posts.join("\n");
}

function threadPage(threadUrl, page) {
  const base = new URL(threadUrl);
  base.search = "";
  const slug = base.pathname.split("/").filter(Boolean).pop();
  const pageUrl = (n) => (n === 1 ? base.toString() : `${base}?page=${n}`);
  const links = [
    `${base.origin}/`,
    `${base.origin}/login`,
    ...Array.from({ length: THREAD_PAGES }, (_, i) => pageUrl(i + 1)),
    `${base.origin}/thread/another-thread`,
  ];
  return {
    url: pageUrl(page),
    final_url: pageUrl(page),
    title: `Is the harbour bell late this year? | Fennick Forum`,
    description: "A thread on the Fennick Forum.",
    language: "en",
    text:
      `<h1>Is the harbour bell late this year?</h1>\n` +
      `<nav><a href="/login">Log in</a></nav>\n` +
      threadPosts(slug, page),
    author: null,
    published_date: "2026-11-11T09:01:00Z",
    links,
    latency_ms: 812,
    format: "html",
    page_metadata: {
      og: { site_name: "Fennick Forum" },
      other: { "page-number": String(page), "page-total": String(THREAD_PAGES) },
    },
  };
}

function tinyfish(req, res, body) {
  const json = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!req.headers["x-api-key"]) return json(401, { error: "missing_api_key" });

  let urls;
  try {
    urls = JSON.parse(body).urls;
  } catch {
    return json(400, { error: "bad_json" });
  }
  hits[hits.length - 1].urls = urls;
  const asked = Array.isArray(urls) && typeof urls[0] === "string" ? urls[0] : "";

  let target;
  try {
    target = new URL(asked);
  } catch {
    return json(200, { results: [], errors: [{ url: asked, error: "invalid_url" }] });
  }

  // The fake only knows the forum. Anything else is a URL the app should
  // never have sent, and is answered as a failure the tests will notice.
  if (target.hostname !== "forum.e2e.test" || !target.pathname.startsWith("/thread/")) {
    return json(200, { results: [], errors: [{ url: asked, error: "not_a_fixture" }] });
  }
  if (target.pathname === "/thread/refused") {
    return json(200, { results: [], errors: [{ url: asked, error: "bot_blocked", status: 403 }] });
  }

  const page = Number.parseInt(target.searchParams.get("page") ?? "1", 10) || 1;
  if (page < 1 || page > THREAD_PAGES) {
    return json(200, { results: [], errors: [{ url: asked, error: "not_found", status: 404 }] });
  }
  return json(200, { results: [threadPage(asked, page)], errors: [] });
}

// ── The tests' handle ────────────────────────────────────────────────

function control(req, res, path, body) {
  const json = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  let data = {};
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    return json(400, { error: "bad json" });
  }

  if (path === "/health") return json(200, { ok: true });
  if (path === "/hits") return json(200, { hits });
  if (path === "/mode" && req.method === "POST") {
    modes.set(data.path, data.mode);
    return json(200, { ok: true });
  }
  if (path === "/release" && req.method === "POST") {
    // From now on the page answers at once, and anyone waiting gets it.
    modes.set(data.path, "ok");
    const waiting = held.get(data.path) ?? [];
    held.delete(data.path);
    for (const send of waiting) send();
    return json(200, { ok: true, released: waiting.length });
  }
  return json(404, { error: "no such control" });
}

// ── One handler for both ports ───────────────────────────────────────

function handle(req, res) {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  const url = new URL(req.url ?? "/", "http://placeholder");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (host !== "control.e2e.test") {
      hits.push({
        host,
        method: req.method,
        path: url.pathname + url.search,
        apiKey: Boolean(req.headers["x-api-key"]) || undefined,
      });
    }
    try {
      if (host === "control.e2e.test") return control(req, res, url.pathname, body);
      if (host === TINYFISH_HOST) return tinyfish(req, res, body);
      if (host === "openrouter.ai") {
        res.writeHead(503, { "content-type": "application/json" });
        return void res.end('{"error":{"message":"fixture: OpenRouter is not available in tests"}}');
      }
      if (host === "forum.e2e.test") return wall(res);
      if (host === "news.e2e.test") return news(req, res, url.pathname);
      res.writeHead(421, { "content-type": "text/plain" });
      res.end(`fixture: unknown host ${host}`);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`fixture error: ${err instanceof Error ? err.message : err}`);
    }
  });
}

createHttp(handle).listen(80, () => console.log("fixtures: http on 80"));
createHttps(
  { key: readFileSync(process.env.E2E_TLS_KEY), cert: readFileSync(process.env.E2E_TLS_CERT) },
  handle
).listen(443, () => console.log("fixtures: https on 443"));
