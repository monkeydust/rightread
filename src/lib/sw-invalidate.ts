/**
 * Tells the service worker an article has changed on the server, so the next
 * request for it goes to the network instead of the article cache.
 *
 * Articles are cache-first (see public/sw.js), which is right for a page that
 * is finished and wrong for the one action that changes an article in place:
 * Summarise re-fetches the thread and adds the summary to the page. Call this
 * before reloading, or the reload shows the page as it was.
 *
 * Always settles, and quickly. If there is no controlling worker the answer
 * is immediate; if the worker never acks, the wait is capped. The reload that
 * follows is the point, and nothing may hold it hostage.
 */
export function invalidateArticleCache(path: string): Promise<void> {
  return new Promise((resolve) => {
    const controller =
      typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null;
    if (!controller) {
      resolve();
      return;
    }

    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1500);

    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = done;
      controller.postMessage({ type: "INVALIDATE_ARTICLE", path }, [channel.port2]);
    } catch {
      done();
    }
  });
}
