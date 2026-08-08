/**
 * Boot hook (Next.js instrumentation convention): starts the hourly source
 * poll. This is the app's only scheduled work, and it lives in-process rather
 * than in system cron so a deploy is still just "pull and rebuild" — nothing
 * to configure on the box.
 *
 * A plain setInterval is safe here for the same reason the SSE hub in
 * src/lib/events.ts works: the app is exactly one Node process in one
 * container. Running more than one instance would poll every feed once per
 * instance — harmless to data (admission is deduped by unique(userId, url))
 * but wasteful, so revisit this alongside events.ts if that ever changes.
 */

/**
 * 15 minutes: fast feeds (HN's frontpage) rotate stories in under an hour,
 * and a poll of a quiet feed costs one HTTP request — cheap enough to pay
 * for freshness. Extraction work only happens when a poll finds new entries.
 */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * First sweep shortly after boot rather than immediately: extraction and
 * embedding compete with serving the first pages, and a deploy restarting the
 * container should not begin by pinning the CPU.
 */
const FIRST_POLL_DELAY_MS = 2 * 60 * 1000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Imported dynamically so the edge bundle never sees Prisma or jsdom.
  const { refreshAllSources } = await import("@/lib/sources/refresh");

  const timer = setInterval(() => void refreshAllSources(), POLL_INTERVAL_MS);
  timer.unref(); // never keep the process alive just to poll feeds

  const first = setTimeout(() => void refreshAllSources(), FIRST_POLL_DELAY_MS);
  first.unref();

  console.log(
    `[sources] poller started (every ${POLL_INTERVAL_MS / 60_000} min, first in ${
      FIRST_POLL_DELAY_MS / 60_000
    } min)`
  );
}
