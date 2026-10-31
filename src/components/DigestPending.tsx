"use client";

import { useEffect } from "react";
import { netFetch } from "@/lib/connectivity";
import { invalidateArticleCache } from "@/lib/sw-invalidate";
import { Working } from "@/components/Working";

/**
 * Shown on a digest whose essay is still being written. Polls until it is
 * done, then reloads past the service worker's copy — the same full-reload
 * route ThreadSummary takes, for the same reason: the article is cached, and
 * a router refresh would be answered with the page as it was.
 */
export function DigestPending({ itemId }: { itemId: string }) {
  useEffect(() => {
    let cancelled = false;
    const path = `/read/${itemId}`;

    void (async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 3000));
        if (cancelled) return;
        const res = await netFetch(`/api/compact/${itemId}`).catch(() => null);
        if (!res?.ok) continue;
        const body = (await res.json().catch(() => null)) as { pending?: boolean } | null;
        if (body && body.pending === false) {
          if (cancelled || window.location.pathname !== path) return;
          await invalidateArticleCache(path);
          window.location.reload();
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [itemId]);

  return (
    <p
      className="mt-8 flex items-center gap-2 text-sm"
      style={{ color: "color-mix(in srgb, var(--paper-text) 60%, transparent)" }}
    >
      <Working />
      Writing the digest… the list below is already complete.
    </p>
  );
}
