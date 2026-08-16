/*
 * rightread service worker.
 *
 * The point is offline reading, so the strategy is deliberately narrow:
 *  - /read/<id> pages   → stale-while-revalidate; once read, readable offline
 *  - the top of the queue → precached ahead of time, readable before ever opened
 *  - other navigations  → network-first, falling back to cache, then /offline
 *  - static assets      → cache-first
 *  - anything /api/ or auth-related → never cached
 *
 * Article pages are server-rendered per user. Caches are per-device and
 * per-origin, so that is fine here, but SIGN OUT CLEARS THEM (see the message
 * handler at the bottom) — otherwise the next user on the device could read
 * them from cache.
 */

// Bump on any change to styling or markup: cached article HTML references
// hashed CSS/font URLs, and stale HTML pointing at deleted chunks renders
// unstyled. Activation deletes every cache not matching this suffix.
const VERSION = "v16";
const SHELL_CACHE = `rr-shell-${VERSION}`;
const ARTICLE_CACHE = `rr-articles-${VERSION}`;
const ASSET_CACHE = `rr-assets-${VERSION}`;

/*
 * Articles pulled down before they are opened, so the queue you can SEE
 * offline is the queue you can READ offline. Kept apart from ARTICLE_CACHE
 * because the two are pruned on completely different rules: this one is
 * synced to mirror the top of the queue exactly, and anything that falls out
 * of the top is dropped, whereas an article you deliberately opened stays
 * until you sign out. Merging them would mean a reorder silently evicting
 * something you had already read.
 */
const PRECACHE = `rr-precache-${VERSION}`;

const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, "/manifest.webmanifest"]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.endsWith(VERSION))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isArticle(url) {
  return url.pathname.startsWith("/read/");
}

/**
 * Whether this is the client router asking for a flight payload.
 *
 * Tapping an article in the queue does NOT request a document — next/link
 * navigates client-side and fetches `/read/<id>?_rsc=<hash>` instead. That
 * request is not `mode: "navigate"`, so it misses the article handler below
 * entirely and goes straight to the network. Offline that is a dead end, which
 * is why a precached document alone still left a tap on the queue failing.
 */
function isRscRequest(request, url) {
  return request.headers.get("RSC") === "1" || url.searchParams.has("_rsc");
}

/**
 * Cache key for an article's flight payload.
 *
 * The router appends a per-build `_rsc` hash to the URL, so the request URL is
 * useless as a key — it changes on every deploy and would never hit. Normalise
 * to the path, and keep it distinct from the document, which has no query.
 */
function rscKey(url) {
  return `${url.pathname}?__rr_rsc=1`;
}

function isNeverCached(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/share") ||
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/settings") ||
    // A group shelf is other people's links and other people's email
    // addresses, and it changes when they act rather than when you do. Caching
    // it would write their data to this device and then serve a stale shelf
    // offline, where Save cannot work anyway.
    url.pathname.startsWith("/groups")
  );
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:png|jpg|jpeg|svg|webp|avif|ico|woff2?)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url)) return;

  // The flight payload for an article, i.e. a tap on the queue. Same
  // stale-while-revalidate shape as the document below, keyed on the path.
  if (isArticle(url) && isRscRequest(request, url)) {
    event.respondWith(
      (async () => {
        const key = rscKey(url);
        const articles = await caches.open(ARTICLE_CACHE);
        const precache = await caches.open(PRECACHE);
        const cached = (await articles.match(key)) ?? (await precache.match(key));

        const network = fetch(request)
          .then((response) => {
            if (response.ok && response.type === "basic" && !response.redirected) {
              articles.put(key, response.clone());
            }
            return response;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(network);
          return cached;
        }

        // Nothing held and nothing to fetch. A network error is the honest
        // answer, and it is also the useful one: the router responds to a
        // failed flight fetch by falling back to a browser navigation, which
        // the document handler below can still serve from the precache.
        return (await network) ?? Response.error();
      })()
    );
    return;
  }

  // Article pages: serve cache immediately, refresh in the background.
  if (isArticle(url) && request.mode === "navigate") {
    event.respondWith(
      caches.open(ARTICLE_CACHE).then(async (cache) => {
        // Precache is the fallback, not the preference: an entry in
        // ARTICLE_CACHE was fetched when you actually opened the page, so it
        // is never older than the precached copy.
        const cached =
          (await cache.match(request)) ??
          (await caches.open(PRECACHE).then((p) => p.match(request)));

        const network = fetch(request)
          .then((response) => {
            // Don't cache redirects to /login — that would pin a signed-out
            // page in place of the article.
            if (response.ok && response.type === "basic" && !response.redirected) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(network);
          return cached;
        }
        return (await network) ?? caches.match(OFFLINE_URL);
      })
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && !response.redirected) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached ?? caches.match(OFFLINE_URL);
        })
    );
  }
});

/**
 * Takes the assets a precached page points at.
 *
 * Without this the precache half-works in the worst way: the HTML is there and
 * the article text renders, but the hashed CSS and JS it references were never
 * fetched — because you never opened that page — so it arrives unstyled. A
 * page you have not visited has not pulled its own chunks.
 */
async function cacheReferencedAssets(html) {
  const cache = await caches.open(ASSET_CACHE);
  const paths = new Set(html.match(/\/_next\/static\/[^"'\\\s>]+/g) ?? []);

  await Promise.all(
    [...paths].map(async (path) => {
      if (await cache.match(path)) return;
      try {
        const response = await fetch(path);
        if (response.ok) await cache.put(path, response);
      } catch {
        // Opportunistic — a miss here just means it is fetched on demand later.
      }
    })
  );
}

async function precacheOne(cache, path) {
  try {
    // Same-origin fetch sends the session cookie, so this is the real article
    // rather than a sign-in page.
    const response = await fetch(path);

    // A redirect means the session lapsed and we were sent to /login. Caching
    // that would pin a sign-in page where an article should be — the exact bug
    // the navigation handler guards against above.
    if (!response.ok || response.redirected || response.type !== "basic") return;

    const html = await response.clone().text();
    await cache.put(path, response);
    await cacheReferencedAssets(html);

    // The document only covers a hard navigation — typing the URL, a reload,
    // or opening the PWA straight at it. Tapping the article in the queue goes
    // through the client router, which wants the flight payload instead, so
    // both have to be here or offline works from one direction only.
    const flight = await fetch(path, { headers: { RSC: "1" } });
    if (flight.ok && !flight.redirected && flight.type === "basic") {
      await cache.put(rscKey(new URL(path, self.location.origin)), flight);
    }
  } catch {
    // Offline or the fetch failed. Precaching is best-effort by definition.
  }
}

/**
 * Mirrors the top of the reading queue into the precache.
 *
 * `paths` arrives already in queue order, so this follows a reorder as well as
 * a new save: promote an old article into the top slice and it gets pulled
 * down on the next sync, exactly like a freshly captured one.
 */
async function syncPrecache(paths) {
  const cache = await caches.open(PRECACHE);
  const wanted = new Set(paths);

  // Prune before fetching, so an article pushed out of the top frees its
  // space before its replacement takes any.
  for (const request of await cache.keys()) {
    if (!wanted.has(new URL(request.url).pathname)) await cache.delete(request);
  }

  // Sequential on purpose: this runs in the background while you are reading,
  // and twenty parallel article fetches would compete with the page you are
  // actually looking at.
  for (const path of paths) {
    // Both forms have to be present to skip. Checking only the document would
    // permanently strand anything cached before the flight payload was stored
    // alongside it.
    const url = new URL(path, self.location.origin);
    const held = (await cache.match(path)) && (await cache.match(rscKey(url)));
    if (held) continue;
    await precacheOne(cache, path);
  }
}

self.addEventListener("message", (event) => {
  /** The app posts this on sign-out so cached articles don't outlive the session. */
  if (event.data?.type === "CLEAR_CACHES") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
    return;
  }

  if (event.data?.type === "PRECACHE_ARTICLES") {
    const paths = Array.isArray(event.data.paths) ? event.data.paths : [];
    // Only ever our own article URLs — a message handler is reachable from any
    // script on the page, and this one causes network fetches.
    const safe = paths.filter((p) => typeof p === "string" && /^\/read\/[\w-]+$/.test(p));
    event.waitUntil(syncPrecache(safe));
  }
});
