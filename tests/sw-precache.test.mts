/**
 * Service-worker precache sync.
 *
 * The worker is plain script, not a module, so it is loaded into a vm context
 * with stubbed `caches` and `fetch` and driven through its own message
 * listener. That runs the shipped file rather than a copy of its logic —
 * a reimplementation here would pass while the deployed worker was broken.
 *
 * What matters is the pruning and the guards. A precache that never prunes
 * grows without limit; one that caches a redirect pins the sign-in page where
 * an article should be, and that failure is invisible until you are offline.
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const ORIGIN = "https://www.rightread.net";

/**
 * Path for anything the worker hands us — string, or a Request-like object.
 *
 * The query has to survive: the flight payload is stored at the same path as
 * the document and told apart only by its `?__rr_rsc=1` marker, so dropping
 * the query here would silently collapse the two into one entry and make the
 * pruning assertions below pass for the wrong reason.
 */
function keyOf(target: unknown): string {
  const raw = typeof target === "string" ? target : (target as { url: string }).url;
  const url = new URL(raw, ORIGIN);
  return url.pathname + url.search;
}

function makeCaches() {
  const stores = new Map<string, Map<string, unknown>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (t: unknown) => store.get(keyOf(t)),
      put: async (t: unknown, res: unknown) => void store.set(keyOf(t), res),
      delete: async (t: unknown) => store.delete(keyOf(t)),
      // The worker reads `request.url`, so keys must look like real Requests.
      keys: async () => [...store.keys()].map((p) => ({ url: `${ORIGIN}${p}` })),
    };
  };
  return {
    stores,
    open,
    match: async () => undefined,
    // CacheStorage-level, as opposed to the per-cache keys()/delete() above:
    // these enumerate and drop whole caches, which is how CLEAR_CACHES works.
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
}

type Opts = { redirected?: boolean; ok?: boolean; html?: string };

/** Loads the real sw.js and returns its listeners plus the stubs it ran against. */
function loadWorker(responses: Record<string, Opts> = {}) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const fetched: string[] = [];
  const cacheStore = makeCaches();
  // Flipped mid-test to model the actual scenario: precache while there is a
  // network, then read with none at all.
  //
  // `stalls` is the aeroplane case and the one that matters: wi-fi associated,
  // navigator.onLine true, connection accepted and then black-holed. The fetch
  // does not fail — it never answers at all. Before timedFetch this wedged the
  // worker permanently; a test that only models `offline` would miss it,
  // because rejecting fast was never the broken path.
  const net = { offline: false, stalls: false };

  const fetchStub = async (
    t: unknown,
    init?: { headers?: Record<string, string>; signal?: AbortSignal }
  ) => {
    const path = keyOf(t);
    if (net.stalls) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      });
    }
    if (net.offline) throw new TypeError("Failed to fetch");
    // Flight-payload fetches are recorded distinctly from document fetches so
    // a test can tell which of the two the worker actually asked for.
    fetched.push(init?.headers?.RSC === "1" ? `${path}#rsc` : path);
    const o = responses[path] ?? {};
    const html = o.html ?? "<html></html>";
    return mkResponse(o, html);
  };

  // A response whose clone is a full response again, so the worker can read
  // the body of a cached copy (it does, to find the build id) the same way it
  // reads a fresh one.
  const mkResponse = (o: Opts, html: string): Record<string, unknown> => ({
    ok: o.ok ?? true,
    redirected: o.redirected ?? false,
    type: "basic",
    clone: () => mkResponse(o, html),
    text: async () => html,
    body: html,
  });

  // The worker constructs `new Response(text)` to remember the build id, and
  // calls `Response.error()` as the last resort when there is nothing cached
  // and no network to ask.
  class ResponseStub {
    private readonly value: string;
    ok = true;
    redirected = false;
    type = "basic";
    constructor(value: string) {
      this.value = String(value);
    }
    async text() {
      return this.value;
    }
    clone() {
      return new ResponseStub(this.value);
    }
    static error() {
      return { networkError: true };
    }
  }

  const sandbox = {
    self: {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn;
      },
      location: { origin: ORIGIN },
      skipWaiting: () => {},
      clients: { claim: () => {} },
    },
    caches: cacheStore,
    fetch: fetchStub,
    Response: ResponseStub,
    URL,
    Set,
    Map,
    Promise,
    Array,
    console,
    // timedFetch needs all three. A vm context gets its own ECMAScript
    // intrinsics but no host APIs, so these have to be handed in explicitly or
    // every fetch branch throws ReferenceError the moment it runs.
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
  };

  // install() uses cache.addAll, which the bare store lacks: fetch through the
  // same stub so the shell cache holds whatever the "server" says /offline is.
  const rawOpen = cacheStore.open;
  cacheStore.open = async (name: string) => {
    const c = await rawOpen(name);
    return {
      ...c,
      addAll: async (paths: string[]) => {
        for (const p of paths) await c.put(p, await fetchStub(p));
      },
    };
  };

  const context = createContext(sandbox);
  runInContext(readFileSync("public/sw.js", "utf8"), context);
  return { listeners, fetched, cacheStore, net, mkResponse };
}

/** Fires a lifecycle listener (install/activate) and awaits its waitUntil. */
async function lifecycle(listeners: Record<string, (e: unknown) => void>, type: string) {
  const pending: Promise<unknown>[] = [];
  listeners[type]({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

/** A page as Next renders it: the build id sits escaped in an inline script. */
const pageOf = (build: string, marker: string) =>
  `<html><script>self.__next_f.push([1,"0:{\\"P\\":null,\\"b\\":\\"${build}\\"}"])</script>${marker}</html>`;

/** Drives the fetch listener and returns whatever it responded with. */
async function sendFetch(
  listeners: Record<string, (e: unknown) => void>,
  path: string,
  opts: { rsc?: boolean } = {}
) {
  let responded: Promise<unknown> | undefined;
  const request = {
    method: "GET",
    url: `${ORIGIN}${path}`,
    mode: opts.rsc ? "cors" : "navigate",
    headers: { get: (name: string) => (opts.rsc && name === "RSC" ? "1" : null) },
  };
  listeners.fetch({
    request,
    respondWith: (p: Promise<unknown>) => {
      responded = p;
    },
    waitUntil: () => {},
  });
  return responded ? await responded : undefined;
}

/** Fires the message listener and awaits whatever it passed to waitUntil. */
async function sendMessage(
  listeners: Record<string, (e: unknown) => void>,
  data: unknown
) {
  const pending: Promise<unknown>[] = [];
  listeners.message({ data, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

function precacheOf(cacheStore: ReturnType<typeof makeCaches>) {
  const name = [...cacheStore.stores.keys()].find((k) => k.startsWith("rr-precache-"));
  return name ? [...cacheStore.stores.get(name)!.keys()].sort() : [];
}

/** Just the documents — each article also stores a flight payload alongside. */
function documentsOf(cacheStore: ReturnType<typeof makeCaches>) {
  return precacheOf(cacheStore).filter((k) => !k.includes("__rr_rsc"));
}

// ── Pulls down the requested queue ────────────────────────────────
{
  const { listeners, fetched, cacheStore } = loadWorker();
  await sendMessage(listeners, {
    type: "PRECACHE_ARTICLES",
    paths: ["/read/a", "/read/b", "/read/c"],
  });

  const cached = documentsOf(cacheStore);
  check(
    "precaches every requested article",
    JSON.stringify(cached) === JSON.stringify(["/read/a", "/read/b", "/read/c"]),
    JSON.stringify(cached)
  );
  check(
    "fetches each one once",
    ["/read/a", "/read/b", "/read/c"].every(
      (p) => fetched.filter((f) => f === p).length === 1
    ),
    JSON.stringify(fetched)
  );
}

// ── A reorder prunes what fell out of the top ─────────────────────
{
  const { listeners, cacheStore } = loadWorker();
  await sendMessage(listeners, {
    type: "PRECACHE_ARTICLES",
    paths: ["/read/a", "/read/b"],
  });

  // /read/a drops out of the top slice, /read/c is promoted into it.
  await sendMessage(listeners, {
    type: "PRECACHE_ARTICLES",
    paths: ["/read/b", "/read/c"],
  });

  const cached = precacheOf(cacheStore);
  check(
    "an article pushed out of the top is dropped",
    !cached.includes("/read/a"),
    JSON.stringify(cached)
  );
  check(
    "an article promoted into the top is pulled down",
    cached.includes("/read/c"),
    JSON.stringify(cached)
  );
  check("one still in the top is kept", cached.includes("/read/b"), JSON.stringify(cached));
}

// ── Already-cached articles are not refetched ─────────────────────
{
  const { listeners, fetched } = loadWorker();
  const paths = ["/read/a", "/read/b"];
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths });
  const afterFirst = fetched.filter((f) => f.startsWith("/read/")).length;

  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths });
  const afterSecond = fetched.filter((f) => f.startsWith("/read/")).length;

  // Two articles, each fetched twice — document and flight payload.
  check(
    "a second sync re-fetches nothing",
    afterFirst === 4 && afterSecond === afterFirst,
    `first ${afterFirst}, second ${afterSecond}`
  );
}

// ── A lapsed session must not pin the sign-in page ────────────────
{
  const { listeners, cacheStore } = loadWorker({
    "/read/b": { redirected: true }, // bounced to /login
  });
  await sendMessage(listeners, {
    type: "PRECACHE_ARTICLES",
    paths: ["/read/a", "/read/b"],
  });

  const cached = precacheOf(cacheStore);
  check("a redirected article is not cached", !cached.includes("/read/b"), JSON.stringify(cached));
  check("its neighbours still are", cached.includes("/read/a"), JSON.stringify(cached));
}

{
  const { listeners, cacheStore } = loadWorker({ "/read/a": { ok: false } });
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a"] });
  check("a failed response is not cached", precacheOf(cacheStore).length === 0);
}

// ── The handler is reachable from any script on the page ──────────
{
  const { listeners, fetched } = loadWorker();
  await sendMessage(listeners, {
    type: "PRECACHE_ARTICLES",
    paths: [
      "/admin",
      "https://evil.example/read/x",
      "/read/../../etc/passwd",
      "//evil.example/read/x",
      42,
      null,
    ],
  });
  check(
    "refuses anything that is not one of our article paths",
    fetched.length === 0,
    JSON.stringify(fetched)
  );
}

// ── The assets the page points at come too ────────────────────────
// Without these the article arrives unstyled: a page you never opened never
// pulled its own hashed CSS and JS.
{
  const html = `<html><head><link rel="stylesheet" href="/_next/static/css/abc123.css"/>
    <script src="/_next/static/chunks/main-def456.js"></script></head><body>hi</body></html>`;
  const { listeners, fetched, cacheStore } = loadWorker({ "/read/a": { html } });
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a"] });

  check(
    "fetches the stylesheet the page references",
    fetched.includes("/_next/static/css/abc123.css"),
    JSON.stringify(fetched)
  );
  check(
    "fetches the script the page references",
    fetched.includes("/_next/static/chunks/main-def456.js"),
    JSON.stringify(fetched)
  );

  const assets = [...cacheStore.stores.keys()].find((k) => k.startsWith("rr-assets-"));
  check("stores them in the asset cache", assets !== undefined && cacheStore.stores.get(assets)!.size === 2);
}

// ── Sign-out still wipes everything ───────────────────────────────
{
  const { listeners, cacheStore } = loadWorker();
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a"] });
  check("something is cached first", documentsOf(cacheStore).length === 1);

  await sendMessage(listeners, { type: "CLEAR_CACHES" });
  check(
    "CLEAR_CACHES removes the precache too",
    cacheStore.stores.size === 0,
    JSON.stringify([...cacheStore.stores.keys()])
  );
}

// ── Both forms of the page are taken ──────────────────────────────
// A tap in the queue goes through the client router and asks for a flight
// payload; only a hard navigation asks for the document. Storing one without
// the other makes offline work from one direction and fail from the other.
{
  const { listeners, fetched, cacheStore } = loadWorker();
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a"] });

  check("fetches the document", fetched.includes("/read/a"), JSON.stringify(fetched));
  check("fetches the flight payload", fetched.includes("/read/a#rsc"), JSON.stringify(fetched));

  const cached = precacheOf(cacheStore);
  check("stores the document", cached.includes("/read/a"), JSON.stringify(cached));
  check(
    "stores the flight payload under its own key",
    cached.includes("/read/a?__rr_rsc=1"),
    JSON.stringify(cached)
  );
}

// ── The train: precache with signal, then read with none ──────────
{
  const { listeners, cacheStore, net } = loadWorker();
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a", "/read/b"] });

  net.offline = true; // airplane mode

  const tapped = await sendFetch(listeners, "/read/a", { rsc: true });
  check(
    "tapping a precached article offline serves the flight payload",
    tapped !== undefined && !(tapped as { networkError?: boolean }).networkError,
    JSON.stringify(tapped)
  );

  const typed = await sendFetch(listeners, "/read/b");
  check(
    "a hard navigation offline serves the precached document",
    typed !== undefined && !(typed as { networkError?: boolean }).networkError,
    JSON.stringify(typed)
  );

  // Nothing was evicted by reading while offline.
  check("both articles still held", precacheOf(cacheStore).length === 4, JSON.stringify(precacheOf(cacheStore)));
}

// ── Offline, for something never precached ────────────────────────
{
  const { listeners, net } = loadWorker();
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a"] });
  net.offline = true;

  const missing = await sendFetch(listeners, "/read/zzz", { rsc: true });
  check(
    "an uncached article returns a network error, so the router falls back",
    (missing as { networkError?: boolean })?.networkError === true,
    JSON.stringify(missing)
  );
}

// ── Pruning covers both forms ─────────────────────────────────────
{
  const { listeners, cacheStore } = loadWorker();
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a", "/read/b"] });
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/b"] });

  const cached = precacheOf(cacheStore);
  check(
    "a dropped article leaves neither document nor payload behind",
    !cached.some((k) => k.startsWith("/read/a")),
    JSON.stringify(cached)
  );
  check("the surviving article keeps both", cached.length === 2, JSON.stringify(cached));
}


// ── The aeroplane: a network that stalls rather than fails ────────
// This is the case that made the app unusable in flight, and the reason
// timedFetch exists. Wi-fi is associated so the browser believes it is online,
// the connection is accepted, and then nothing comes back — ever. Every branch
// here awaits the network before falling back, so without a deadline the
// promise handed to respondWith never settles: the tap produces nothing at all
// and the cached article sits there unreachable. Modelling only `offline`
// would miss it entirely, because failing fast was never the broken path.
{
  const { listeners, cacheStore, net } = loadWorker();
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a"] });

  net.stalls = true;

  const tapped = await sendFetch(listeners, "/read/a", { rsc: true });
  check(
    "a stalled network still serves the precached payload, at once",
    tapped !== undefined && !(tapped as { networkError?: boolean }).networkError,
    JSON.stringify(tapped)
  );

  const doc = await sendFetch(listeners, "/read/a");
  check(
    "and the precached document too",
    doc !== undefined && !(doc as { networkError?: boolean }).networkError,
    JSON.stringify(doc)
  );

  check("nothing was evicted by reading through a stall", precacheOf(cacheStore).length === 2);
}

// ── A stall for something we do NOT hold must still settle ────────
// The point is not the answer, it is that there IS one. Anything that resolves
// lets the router fall back to a full navigation; a pending promise is what
// left the app frozen.
{
  const { listeners, net } = loadWorker();
  net.stalls = true;

  const settled = await Promise.race([
    sendFetch(listeners, "/read/never-seen", { rsc: true }).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("HUNG"), 15_000)),
  ]);
  check("an uncached article gives up instead of hanging", settled === "settled", String(settled));
}



// ── Articles survive the deploy that splits the versions ──────────
// The fix that stops articles being deleted must not delete them on its way
// in. Anything downloaded under the old single-version scheme is adopted into
// the new data-versioned caches before the stale ones are pruned.
{
  const { listeners, cacheStore } = loadWorker();

  // Seed what an already-installed worker would be holding.
  const legacyPre = await cacheStore.open("rr-precache-v21");
  await legacyPre.put("/read/old", { body: "old article" });
  await legacyPre.put("/read/old?__rr_rsc=1", { body: "old payload" });
  const legacyShell = await cacheStore.open("rr-shell-v21");
  await legacyShell.put("/", { body: "stale markup" });

  await new Promise<void>((resolve) => {
    listeners.activate({ waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).then(() => resolve()) });
  });

  const adopted = precacheOf(cacheStore);
  check(
    "the downloaded article moved to the new cache",
    adopted.includes("/read/old") && adopted.includes("/read/old?__rr_rsc=1"),
    JSON.stringify(adopted)
  );
  check(
    "the old article cache is gone",
    !cacheStore.stores.has("rr-precache-v21"),
    JSON.stringify([...cacheStore.stores.keys()])
  );
  // Stale markup is still evicted — that is what VERSION is for, and keeping it
  // would reintroduce the unstyled-article bug the bump exists to prevent.
  check(
    "stale shell markup is still dropped",
    !cacheStore.stores.has("rr-shell-v21"),
    JSON.stringify([...cacheStore.stores.keys()])
  );
}


// ── The queue is state, not content ───────────────────────────────
// Articles are finished, so serving a cached copy instantly is right. A queue's
// whole job is to show what you just saved, so it must come from the network
// whenever there is one. Getting this backwards meant saving a page and not
// seeing it until you pulled to refresh.
{
  const responses: Record<string, { html?: string }> = { "/": { html: "<html>first</html>" } };
  const { listeners, cacheStore, net } = loadWorker(responses);

  // Populate the cache.
  await sendFetch(listeners, "/", { rsc: true });
  const cachedNames = [...cacheStore.stores.keys()].filter((n) => n.startsWith("rr-shell"));
  check("the queue payload is kept for offline use", cachedNames.length === 1, JSON.stringify(cachedNames));

  // The server now has something newer — a freshly saved article.
  responses["/"] = { html: "<html>second</html>" };
  const second = await sendFetch(listeners, "/", { rsc: true });
  check(
    "a queue with a network comes from the server, not the cache",
    (second as { body?: string })?.body === "<html>second</html>",
    JSON.stringify(second)
  );

  // With no network at all, the cached copy is what keeps the app usable.
  net.offline = true;
  const offline = await sendFetch(listeners, "/", { rsc: true });
  check(
    "offline the queue still falls back to the cache",
    offline !== undefined && !(offline as { networkError?: boolean }).networkError,
    JSON.stringify(offline)
  );
}

// ── A stalled network must not wedge the queue either ─────────────
{
  const { listeners, net } = loadWorker({ "/": { html: "<html>x</html>" } });
  await sendFetch(listeners, "/", { rsc: true });

  net.stalls = true;
  const settled = await Promise.race([
    sendFetch(listeners, "/", { rsc: true }).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("HUNG"), 15_000)),
  ]);
  check("a stalled queue request gives up and uses the cache", settled === "settled", String(settled));
}

// ── An article changed on the server: the page must be able to forget it ──
// Summarise re-fetches a thread and adds the summary to the article page. The
// article cache is cache-first, so without an invalidation the reload after
// that press showed the page as it was and the summary appeared only after an
// app restart.
{
  const responses = { "/read/a": { html: "<html>before</html>" } };
  const { listeners, cacheStore } = loadWorker(responses);
  // A cached entry is the stub's clone, which only has text(); read that.
  const bodyOf = async (r: unknown) => (r as { text: () => Promise<string> }).text();

  // Open the article once, as a document and as a flight payload: both cached.
  const first = await sendFetch(listeners, "/read/a");
  check("article document served", (await bodyOf(first)) === "<html>before</html>");
  await sendFetch(listeners, "/read/a", { rsc: true });
  // Also present in the precache, as it would be for a queue article.
  await sendMessage(listeners, { type: "PRECACHE_ARTICLES", paths: ["/read/a"] });

  // The server now has a different page.
  responses["/read/a"] = { html: "<html>after</html>" };

  // Without invalidation the cache-first article branch still answers stale —
  // that is the deliberate design, and the bug this message exists to bypass.
  const stale = await sendFetch(listeners, "/read/a");
  check(
    "cache-first article still serves the old copy (the reason invalidation exists)",
    (await bodyOf(stale)) === "<html>before</html>"
  );

  // The page asks the worker to forget the article and waits for the ack.
  const acks: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  listeners.message({
    data: { type: "INVALIDATE_ARTICLE", path: "/read/a" },
    ports: [{ postMessage: (m: unknown) => acks.push(m) }],
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
  check("INVALIDATE_ARTICLE acks on the reply port", JSON.stringify(acks) === JSON.stringify([{ ok: true }]), JSON.stringify(acks));

  const articleStore = [...cacheStore.stores.entries()].find(([k]) => k.startsWith("rr-articles-"))?.[1];
  const preStore = [...cacheStore.stores.entries()].find(([k]) => k.startsWith("rr-precache-"))?.[1];
  check("document dropped from the article cache", !articleStore?.has("/read/a"));
  check("flight payload dropped from the article cache", !articleStore?.has("/read/a?__rr_rsc=1"));
  check("document dropped from the precache", !preStore?.has("/read/a"));
  check("flight payload dropped from the precache", !preStore?.has("/read/a?__rr_rsc=1"));

  const fresh = await sendFetch(listeners, "/read/a");
  check("the reload after invalidation reaches the server", (await bodyOf(fresh)) === "<html>after</html>");

  // Guards: a message handler is reachable from any script on the page.
  const badAcks: unknown[] = [];
  listeners.message({
    data: { type: "INVALIDATE_ARTICLE", path: "/settings" },
    ports: [{ postMessage: (m: unknown) => badAcks.push(m) }],
    waitUntil: () => {},
  });
  check("INVALIDATE_ARTICLE refuses a non-article path", JSON.stringify(badAcks) === JSON.stringify([{ ok: false }]));
  // No reply port at all must not throw.
  let threw = false;
  try {
    listeners.message({ data: { type: "INVALIDATE_ARTICLE", path: "/read/a" }, waitUntil: () => {} });
  } catch {
    threw = true;
  }
  check("INVALIDATE_ARTICLE without a reply port is fine", !threw);
}

// ── A cached article from an older build is a fossil, not a fast path ──
// Articles are cached under DATA_VERSION so a deploy keeps the library, but a
// cached page names the chunks of the build it was saved under. Served after a
// deploy it runs code the server has replaced — every fix shipped to the reader
// was invisible on any article already opened once. The worker now reads the
// build id out of the copy and the current one out of the shell it installed.
{
  const { listeners, cacheStore, fetched, net, mkResponse } = loadWorker({
    "/offline": { html: pageOf("B", "offline") },
    "/manifest.webmanifest": { html: "{}" },
    "/read/a": { html: pageOf("B", "fresh-from-B") },
  });
  await lifecycle(listeners, "install"); // shell now knows the server is on B
  const bodyOf = async (r: unknown) => (r as { text: () => Promise<string> }).text();

  // A copy saved under build A, as the phone would hold after a deploy.
  const articles = await cacheStore.open("rr-articles-d1");
  await articles.put("/read/a", mkResponse({}, pageOf("A", "fossil-from-A")));

  const served = await sendFetch(listeners, "/read/a");
  check("an article cached under an older build is fetched fresh", (await bodyOf(served)).includes("fresh-from-B"), await bodyOf(served));
  check("and the fresh copy replaces the fossil", (await bodyOf(await articles.match("/read/a"))).includes("fresh-from-B"));

  // Same build: served at once from the cache, as before.
  fetched.length = 0;
  await articles.put("/read/a", mkResponse({}, pageOf("B", "cached-from-B")));
  const instant = await sendFetch(listeners, "/read/a");
  check("an article cached under this build is served from the cache", (await bodyOf(instant)).includes("cached-from-B"));

  // Older build but no network: the fossil is still better than nothing.
  await articles.put("/read/a", mkResponse({}, pageOf("A", "fossil-from-A")));
  net.offline = true;
  const fallback = await sendFetch(listeners, "/read/a");
  check("offline, an older-build copy is still served", (await bodyOf(fallback)).includes("fossil-from-A"));
  net.offline = false;

  // The flight payload follows the same rule.
  await articles.put("/read/a?__rr_rsc=1", mkResponse({}, `0:{"b":"A"}payload-from-A`));
  const payload = await sendFetch(listeners, "/read/a", { rsc: true });
  check("an older-build flight payload is fetched fresh too", (await bodyOf(payload)).includes("fresh-from-B"));
}

// ── The build id is re-learned from fresh pages, not only at install ──
// A deploy that does not touch sw.js installs no new worker, so the shell's
// /offline still names the old build. The first fresh page the worker stores
// corrects it, and cached articles from the old build stop being trusted.
{
  const { listeners, cacheStore, mkResponse } = loadWorker({
    "/offline": { html: pageOf("A", "offline") },
    "/manifest.webmanifest": { html: "{}" },
    "/": { html: `0:{"b":"B"}queue` },
    "/read/a": { html: pageOf("B", "fresh-from-B") },
  });
  await lifecycle(listeners, "install"); // shell thinks: A
  const bodyOf = async (r: unknown) => (r as { text: () => Promise<string> }).text();
  const articles = await cacheStore.open("rr-articles-d1");
  await articles.put("/read/a", mkResponse({}, pageOf("A", "cached-from-A")));

  // Opening the queue (network-first) hands the worker a page from build B.
  await sendFetch(listeners, "/", { rsc: true });
  await new Promise((r) => setTimeout(r, 20)); // noteBuild runs off waitUntil

  const served = await sendFetch(listeners, "/read/a");
  check("after seeing a newer build, older-build articles go network-first", (await bodyOf(served)).includes("fresh-from-B"), await bodyOf(served));
}

// ── Activation heals the offline library ──────────────────────────
// A new worker means a deploy happened. Anything held under the old build is
// re-fetched in the background so it is readable offline afterwards, instead
// of being a page whose chunks no longer exist.
{
  const { listeners, cacheStore, fetched, mkResponse } = loadWorker({
    "/offline": { html: pageOf("B", "offline") },
    "/manifest.webmanifest": { html: "{}" },
    "/read/old": { html: pageOf("B", "healed") },
    "/read/fine": { html: pageOf("B", "already-fine") },
  });
  await lifecycle(listeners, "install");
  const bodyOf = async (r: unknown) => (r as { text: () => Promise<string> }).text();
  const pre = await cacheStore.open("rr-precache-d1");
  await pre.put("/read/old", mkResponse({}, pageOf("A", "stale")));
  await pre.put("/read/fine", mkResponse({}, pageOf("B", "current")));

  fetched.length = 0;
  await lifecycle(listeners, "activate");

  check("activation re-fetches the stale-build article", fetched.includes("/read/old") && fetched.includes("/read/old#rsc"), fetched.join(","));
  check("and leaves the current-build one alone", !fetched.includes("/read/fine"));
  check("the healed copy is from the new build", (await bodyOf(await pre.match("/read/old"))).includes("healed"));
}

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
