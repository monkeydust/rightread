/**
 * In-process pub/sub for live UI updates.
 *
 * Background work — extraction, then classification — finishes seconds after
 * the request that triggered it has already returned. This lets those
 * completions push to any open tab instead of the client polling for them.
 *
 * Deliberately in-process, not Redis or a message broker: rightread runs as a
 * single Node process in a single container, so a module-level registry is the
 * whole mechanism. **If it is ever run as more than one instance this breaks
 * silently** — a tab connected to instance A will never see work finished on
 * instance B. At that point this needs a shared broker, and the SSE route
 * becomes a subscriber to it rather than to this map.
 *
 * Events are intentionally thin: they say *that* a user's items changed, not
 * what changed. The client refetches, which keeps one source of truth for how
 * an item is shaped and makes a missed event self-healing rather than a
 * permanent inconsistency.
 */

export type ItemsChanged = {
  type: "items-changed";
  /** Why, purely for logging and client-side debugging. */
  cause: "captured" | "extracted" | "classified" | "updated" | "deleted";
  itemId?: string;
};

/**
 * A group this user belongs to changed — someone shared, or membership moved.
 *
 * Delivered to every member, so unlike `items-changed` one publish call has
 * several recipients; see `publishToAll`. Thin for the same reason: the client
 * refetches the shelf rather than trying to apply a delta.
 */
export type GroupsChanged = {
  type: "groups-changed";
  cause: "shared" | "dismissed" | "membership" | "removed";
  groupId?: string;
};

export type AppEvent = ItemsChanged | GroupsChanged;

type Listener = (event: AppEvent) => void;

/**
 * Survives hot-reload in dev. Without this, every edit leaks the previous
 * module's listeners and connected tabs stop receiving anything.
 */
const globalForEvents = globalThis as unknown as {
  rightreadListeners?: Map<string, Set<Listener>>;
};

const listeners: Map<string, Set<Listener>> =
  globalForEvents.rightreadListeners ?? new Map();

if (process.env.NODE_ENV !== "production") {
  globalForEvents.rightreadListeners = listeners;
}

/** @returns an unsubscribe function. Always call it — a leaked listener is a leaked connection. */
export function subscribe(userId: string, listener: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);

  return () => {
    const current = listeners.get(userId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(userId);
  };
}

/**
 * Notifies a user's open tabs. Never throws: publishing is a side effect of
 * background work, and a broken listener must not fail the work that triggered
 * it — the same contract classification already honours.
 */
export function publish(userId: string, event: AppEvent): void {
  const set = listeners.get(userId);
  if (!set?.size) return;

  for (const listener of set) {
    try {
      listener(event);
    } catch (err) {
      console.warn("[events] listener threw, dropping it:", err);
      set.delete(listener);
    }
  }
}

/**
 * Notifies several users of the same event — a group share reaching everyone on
 * the shelf.
 *
 * A loop over `publish` rather than a broadcast channel, because the registry
 * is keyed by user and a group's membership is small. Inherits `publish`'s
 * contract: it never throws, and a user with no open tab costs nothing.
 */
export function publishToAll(userIds: Iterable<string>, event: AppEvent): void {
  for (const userId of userIds) publish(userId, event);
}

/** Connected tab count for a user — used by the SSE route's logging. */
export function subscriberCount(userId: string): number {
  return listeners.get(userId)?.size ?? 0;
}
