/**
 * Whether the app can currently reach its own server.
 *
 * `navigator.onLine` alone is not enough, and the reason is the bug this exists
 * for: aeroplane wi-fi associates, so the browser reports `onLine === true`,
 * while nothing routes past the access point. Believing that flag would leave
 * the UI insisting it is online while every request stalls.
 *
 * So this combines two sources, and trusts the more pessimistic one:
 *
 *   - `navigator.onLine`, which is instant and reliable in one direction. False
 *     means definitely offline; true means only "the radio is on".
 *   - What actually happened to recent requests. A request that failed or timed
 *     out is direct evidence, and it catches captive portals and a server that
 *     is simply down — neither of which the flag can see.
 *
 * Deliberately not a periodic ping: polling to ask "am I online" is the same
 * wasted request the poller already learned not to make, and every real request
 * the app sends is a better probe than a synthetic one.
 */

type Listener = (online: boolean) => void;

const listeners = new Set<Listener>();

/** Optimistic at boot: assume reachable until something says otherwise. */
let reachable = true;
let watching = false;

function flagOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function isOnline(): boolean {
  return flagOnline() && reachable;
}

function announce() {
  const now = isOnline();
  for (const listener of listeners) {
    try {
      listener(now);
    } catch {
      // A subscriber that throws must not stop the others hearing about it.
    }
  }
}

export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  if (!watching && typeof window !== "undefined") {
    watching = true;
    // The browser's own events are worth having: `online` is the cheapest
    // possible signal that it is worth retrying, and it fires the moment a
    // phone leaves aeroplane mode.
    window.addEventListener("offline", () => {
      reachable = false;
      announce();
    });
    window.addEventListener("online", () => {
      // Only that the radio is back. Whether anything routes is unknown until a
      // real request says so, so this is hopeful rather than authoritative.
      reachable = true;
      announce();
    });
  }
  return () => listeners.delete(listener);
}

/**
 * Records what happened to a real request.
 *
 * One failure is enough to go offline — the cost of being wrong is a dot and a
 * queued write, and the alternative is a UI that lies while nothing works.
 */
export function reportNetworkResult(ok: boolean) {
  if (reachable === ok) return;
  reachable = ok;
  announce();
}

/**
 * How long a client request may run before it is treated as a failure.
 *
 * Matches the service worker's own deadline. Anything longer and the person has
 * already concluded the app is broken.
 */
export const CLIENT_TIMEOUT_MS = 8000;

/**
 * `fetch` that always settles, and reports what it learned.
 *
 * Every client-side call in this app should go through it. A bare `fetch` on a
 * stalled connection hangs for the OS timeout, which is how tapping things came
 * to do nothing at all in flight.
 */
export async function netFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    // A 5xx means the server answered, so the network is fine even though the
    // request was not. Only a transport failure is evidence about reachability.
    reportNetworkResult(true);
    return response;
  } catch (err) {
    reportNetworkResult(false);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** True when a thrown error is "the network did not answer", not "the server said no". */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return err instanceof TypeError;
}
