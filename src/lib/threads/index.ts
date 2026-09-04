import { hnAdapter } from "./hn";
import type { Thread, ThreadAdapter } from "./types";

export type { Thread, ThreadComment, ThreadAdapter } from "./types";
export { renderThread } from "./render";
export { hnItemId } from "./hn";

/**
 * Sites we can read as a thread rather than as a page. Order matters only if
 * two adapters ever claim the same host; today there is one.
 *
 * Not here yet, and why:
 *  - Reddit: a server fetch of any Reddit URL, `.json` included, is answered
 *    with a bot wall. Threads there stay on the paste path.
 *  - Stack Exchange, GitHub, Discourse: real APIs exist; nobody has saved one
 *    yet. Add the adapter when the first one lands, against a real fixture.
 */
const ADAPTERS: ThreadAdapter[] = [hnAdapter];

export function threadAdapterFor(
  url: string
): { adapter: ThreadAdapter; id: string } | null {
  for (const adapter of ADAPTERS) {
    const id = adapter.match(url);
    if (id) return { adapter, id };
  }
  return null;
}

/** Fetches the thread at `url`. Throws with a message fit to show the user. */
export async function fetchThread(url: string): Promise<Thread> {
  const found = threadAdapterFor(url);
  if (!found) throw new Error("This site cannot be read as a thread");
  return found.adapter.fetch(url, found.id);
}
