/**
 * The decisions behind `ExtractionWatch` (the reader's check that the page it
 * is showing still matches the item on the server), kept apart from the
 * component so they can be tested without a browser.
 *
 * Why the reader needs this at all: an article page is served from the
 * service worker's cache at once (see public/sw.js), and nothing on the page
 * asked the server anything. So a page cached while its extraction was
 * pending or failed went on saying so after the extraction had succeeded —
 * the first production save through the fetch fallback showed "Blocked" in
 * the reader half a minute after the article had been stored.
 */

export type WatchedStatus = "pending" | "failed";
export type WatchStep = "reload" | "poll" | "stop";

/** Between checks while an extraction is in progress. */
export const WATCH_INTERVAL_MS = 3000;

/**
 * How long a pending page keeps asking. Longer than the fetch fallback's own
 * budget for a save, so a long thread is seen through; bounded, so a row
 * stuck at pending cannot poll for the life of the tab.
 */
export const WATCH_LIMIT_MS = 5 * 60 * 1000;

/** A second reload for the same state inside this window is refused. */
export const RELOAD_GUARD_MS = 15_000;

/**
 * What to do, given the status this page was rendered with and the status
 * the server reports now (`null` when it could not be asked).
 *
 *  - They differ: the page is behind. Reload it past the cache.
 *  - Both pending: keep asking.
 *  - Both failed: nothing to wait for.
 *  - No answer: a pending page keeps trying; a failed one leaves it.
 */
export function watchStep(rendered: WatchedStatus, server: string | null): WatchStep {
  if (server === null) return rendered === "pending" ? "poll" : "stop";
  if (server !== rendered) return "reload";
  return server === "pending" ? "poll" : "stop";
}

/** The value stored when a reload is made, naming the state it left. */
export function reloadGuard(rendered: WatchedStatus, now: number): string {
  return `${rendered}:${now}`;
}

/**
 * Whether a reload may be made. Refused only when this same state was
 * reloaded away from a moment ago and is on screen again — that is a cache
 * that would not clear, and reloading again would loop.
 */
export function reloadAllowed(guard: string | null, rendered: WatchedStatus, now: number): boolean {
  if (!guard) return true;
  const [state, at] = guard.split(":");
  const when = Number(at);
  if (state !== rendered || !Number.isFinite(when)) return true;
  return now - when > RELOAD_GUARD_MS;
}
