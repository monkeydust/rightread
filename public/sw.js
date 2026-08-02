/*
 * rightread service worker.
 *
 * The point is offline reading, so the strategy is deliberately narrow:
 *  - /read/<id> pages   → stale-while-revalidate; once read, readable offline
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
const VERSION = "v8";
const SHELL_CACHE = `rr-shell-${VERSION}`;
const ARTICLE_CACHE = `rr-articles-${VERSION}`;
const ASSET_CACHE = `rr-assets-${VERSION}`;

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

function isNeverCached(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/share") ||
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/settings")
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

  // Article pages: serve cache immediately, refresh in the background.
  if (isArticle(url) && request.mode === "navigate") {
    event.respondWith(
      caches.open(ARTICLE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);

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

/** The app posts this on sign-out so cached articles don't outlive the session. */
self.addEventListener("message", (event) => {
  if (event.data?.type === "CLEAR_CACHES") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});
