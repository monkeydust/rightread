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

/** Path for anything the worker hands us — string, or a Request-like object. */
function keyOf(target: unknown): string {
  const raw = typeof target === "string" ? target : (target as { url: string }).url;
  return raw.startsWith("http") ? new URL(raw).pathname : raw;
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

  const fetchStub = async (t: unknown) => {
    const path = keyOf(t);
    fetched.push(path);
    const o = responses[path] ?? {};
    const html = o.html ?? "<html></html>";
    return {
      ok: o.ok ?? true,
      redirected: o.redirected ?? false,
      type: "basic",
      clone: () => ({ text: async () => html }),
      text: async () => html,
      body: html,
    };
  };

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
    URL,
    Set,
    Map,
    Promise,
    Array,
    console,
  };

  const context = createContext(sandbox);
  runInContext(readFileSync("public/sw.js", "utf8"), context);
  return { listeners, fetched, cacheStore };
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

// ── Pulls down the requested queue ────────────────────────────────
{
  const { listeners, fetched, cacheStore } = loadWorker();
  await sendMessage(listeners, {
    type: "PRECACHE_ARTICLES",
    paths: ["/read/a", "/read/b", "/read/c"],
  });

  const cached = precacheOf(cacheStore);
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

  check(
    "a second sync re-fetches nothing",
    afterFirst === 2 && afterSecond === 2,
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
  check("something is cached first", precacheOf(cacheStore).length === 1);

  await sendMessage(listeners, { type: "CLEAR_CACHES" });
  check(
    "CLEAR_CACHES removes the precache too",
    cacheStore.stores.size === 0,
    JSON.stringify([...cacheStore.stores.keys()])
  );
}

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
