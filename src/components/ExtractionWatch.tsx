"use client";

import { useEffect } from "react";
import { isOnline, netFetch } from "@/lib/connectivity";
import { invalidateArticleCache } from "@/lib/sw-invalidate";
import {
  WATCH_INTERVAL_MS,
  WATCH_LIMIT_MS,
  reloadAllowed,
  reloadGuard,
  watchStep,
  type WatchedStatus,
} from "@/lib/extraction-watch";

/**
 * Rendered on a reader page whose extraction is pending or failed. Shows
 * nothing. It asks the server what state the item is in now and, when that is
 * no longer the state this page was rendered with, reloads past the service
 * worker's copy — the same full-reload route DigestPending and ThreadSummary
 * take, for the same reason: the article is cached, and a router refresh
 * would be answered with the page as it was.
 *
 * Two cases, one mechanism:
 *  - the page is open while the extraction runs (a blocked thread fetched
 *    through the fallback takes up to a minute): it polls, then shows the
 *    article;
 *  - the page came out of the cache saying "failed" or "extracting" for an
 *    item that has since been stored: the first check finds the difference.
 *
 * It also asks again when the app returns to the foreground, which is how a
 * failed page left open learns that a re-share from another app worked.
 */
export function ExtractionWatch({ itemId, status }: { itemId: string; status: WatchedStatus }) {
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const path = `/read/${itemId}`;
    const guardKey = `rr:extract-reloaded:${itemId}`;
    const started = Date.now();

    const serverStatus = async (): Promise<string | null> => {
      if (!isOnline()) return null;
      const res = await netFetch(`/api/items/${itemId}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return null;
      const body = (await res.json().catch(() => null)) as { extractStatus?: unknown } | null;
      return typeof body?.extractStatus === "string" ? body.extractStatus : null;
    };

    const reload = async () => {
      if (cancelled || window.location.pathname !== path) return;
      try {
        if (!reloadAllowed(sessionStorage.getItem(guardKey), status, Date.now())) return;
        sessionStorage.setItem(guardKey, reloadGuard(status, Date.now()));
      } catch {
        /* no sessionStorage: reload anyway, once is the common case */
      }
      await invalidateArticleCache(path);
      window.location.reload();
    };

    const watch = async () => {
      if (running) return;
      running = true;
      try {
        while (!cancelled) {
          const step = watchStep(status, await serverStatus());
          if (cancelled) return;
          if (step === "reload") {
            await reload();
            return;
          }
          if (step === "stop" || Date.now() - started > WATCH_LIMIT_MS) return;
          await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));
        }
      } finally {
        running = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void watch();
    };

    void watch();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [itemId, status]);

  return null;
}
