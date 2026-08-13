"use client";

import { useEffect } from "react";

/**
 * How far down the queue to keep readable without a network.
 *
 * The number is a bandwidth decision, not a storage one: extracted article
 * HTML is a few tens of KB, so twenty of them is trivial on disk but is twenty
 * requests on someone's cellular data. Twenty is about a commute's worth of
 * reading, which is the case this exists for.
 */
export const OFFLINE_DEPTH = 20;

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
