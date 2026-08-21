"use client";

import { useEffect } from "react";

/**
 * How much of the library to keep readable without a network.
 *
 * This was twenty, on the reasoning that each article is a request on someone's
 * cellular data. That was the wrong trade and it failed the one case the app
 * exists for: a plane, with a queue full of things saved and never opened, of
 * which only the first twenty were actually there — and the archive not at all.
 *
 * Measured, an extracted article is ~40 KB of HTML. A whole library of 200 is
 * therefore about 8 MB, which is a couple of photos. The cap is not a policy
 * about what is worth keeping; it is a guard so that a library that grows to
 * thousands does not quietly try to download all of it. Data Saver is still
 * honoured below, which is the setting that actually means "don't".
 */
export const OFFLINE_DEPTH = 200;

/**
 * Keeps the top of the reading queue readable offline.
 *
 * The service worker only ever cached an article at the moment you opened it,
 * which meant "read it later, offline" failed at exactly the moment it was
 * for — a train, with a queue full of things saved and never opened. This
 * hands the worker the top of the queue while there is still a network, so the
 * queue you can see offline is the queue you can read.
 *
 * `ids` is the live, ordered queue, so this follows a reorder as well as a new
 * save: an older article dragged into the top slice gets pulled down on the
 * next sync just like a freshly captured one.
 */
export function useOfflinePrecache(ids: string[], enabled: boolean) {
  // The worker prunes the precache to exactly the set it is handed, so every
  // caller must pass the WHOLE library. Handing it one status' ids would make
  // the archive page evict the queue's articles and the queue page evict the
  // archive's, each undoing the other on every navigation.
  // The effect depends on the *contents* of the slice, not the array identity,
  // which is rebuilt on every render.
  const key = ids.slice(0, OFFLINE_DEPTH).join(",");

  useEffect(() => {
    if (!enabled || !key) return;
    // The worker is only registered in production builds, and awaiting a
    // registration that will never arrive would hang this promise for the life
    // of the page.
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // Someone who has turned on Data Saver has said, in the clearest terms
    // available, not to spend their data speculatively.
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (connection?.saveData) return;

    const paths = key.split(",").map((id) => `/read/${id}`);

    // Reordering drags the list through a burst of intermediate states, and
    // each one would otherwise fire a prune-and-refetch against a queue order
    // that existed for a few hundred milliseconds.
    const timer = setTimeout(() => {
      navigator.serviceWorker.ready
        .then((registration) => {
          registration.active?.postMessage({ type: "PRECACHE_ARTICLES", paths });
        })
        .catch(() => {
          // No worker, no offline copies. Reading online is unaffected.
        });
    }, 2000);

    return () => clearTimeout(timer);
  }, [key, enabled]);
}
