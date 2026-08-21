/**
 * Changes made offline, kept until the server has heard them.
 *
 * Every operation here is deliberately **absolute and idempotent**: "starred is
 * true", "status is archived", "progress is 0.42". Replaying one twice is
 * harmless, and replaying it late is still correct, because the last write of
 * an absolute value wins whatever order they arrive in.
 *
 * That rules one thing out on purpose. Reordering is expressed as
 * `{move: "up"}` — a *relative* instruction resolved on the server against live
 * position floats. Five queued "up"s replayed against a queue that has since
 * changed produce an order nobody asked for, so reorder is not queueable in
 * this shape and stays online-only until it takes an absolute target.
 *
 * IndexedDB rather than localStorage because this must survive the tab being
 * closed on a plane and reopened three hours later on the ground, and because
 * localStorage is synchronous and blocks the main thread.
 */

const DB_NAME = "rightread-outbox";
const DB_VERSION = 1;
const STORE = "ops";

/** What can be queued. Each maps to exactly one request when it is drained. */
export type OutboxOp =
  | { kind: "patch-item"; itemId: string; body: Record<string, unknown> }
  | { kind: "delete-item"; itemId: string }
  | { kind: "capture"; url: string };

type StoredOp = OutboxOp & { id?: number; at: number };

type Listener = (count: number) => void;
const listeners = new Set<Listener>();
let lastCount = 0;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // autoIncrement gives replay order for free: keys ascend, and a cursor
        // walks them oldest-first, which is the order the user did things in.
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      })
  );
}

function announce(count: number) {
  lastCount = count;
  for (const listener of listeners) {
    try {
      listener(count);
    } catch {
      // One broken subscriber must not stop the others hearing.
    }
  }
}

/** Current pending count without touching the database. */
export function pendingCount(): number {
  return lastCount;
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Recounts from storage and tells subscribers. Safe to call at any time. */
export async function refreshCount(): Promise<number> {
  try {
    const count = await tx("readonly", (store) => store.count());
    announce(count);
    return count;
  } catch {
    return lastCount;
  }
}

/**
 * Queues a change.
 *
 * Never throws: a queue that fails to record is bad, but a star that throws an
 * exception into a click handler is worse, and the change is already reflected
 * on screen by the time this runs.
 */
export async function enqueue(op: OutboxOp): Promise<void> {
  try {
    const stored: StoredOp = { ...op, at: Date.now() };
    await tx("readwrite", (store) => store.add(stored));
    await refreshCount();
  } catch (err) {
    console.warn("[outbox] could not queue", op.kind, err);
  }
}

async function all(): Promise<Required<StoredOp>[]> {
  const rows = await tx<StoredOp[]>("readonly", (store) => store.getAll());
  return (rows as Required<StoredOp>[]).sort((a, b) => a.id - b.id);
}

function requestFor(op: OutboxOp): { url: string; init: RequestInit } {
  switch (op.kind) {
    case "patch-item":
      return {
        url: `/api/items/${op.itemId}`,
        init: {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(op.body),
        },
      };
    case "delete-item":
      return { url: `/api/items/${op.itemId}`, init: { method: "DELETE" } };
    case "capture":
      return {
        url: "/api/items",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: op.url }),
        },
      };
  }
}

let draining = false;

/**
 * Sends everything queued, oldest first.
 *
 * Stops at the first *network* failure and leaves the rest queued — the
 * connection has gone again, and hammering the remaining ops would just refill
 * the same hole. A *server* rejection is different: a 4xx will still be a 4xx
 * in an hour (the item was deleted elsewhere, the URL was never valid), so that
 * op is dropped rather than retried for ever. Both are logged.
 *
 * Returns how many were accepted, and never throws.
 */
export async function drain(
  send: (url: string, init: RequestInit) => Promise<Response>
): Promise<number> {
  if (draining) return 0;
  draining = true;
  let sent = 0;

  try {
    const ops = await all();
    for (const op of ops) {
      const { url, init } = requestFor(op);
      try {
        const response = await send(url, init);
        if (!response.ok && response.status >= 500) {
          // The server is there but unwell. Keep it and try later.
          break;
        }
        if (!response.ok) {
          console.warn(`[outbox] dropping ${op.kind}: server said ${response.status}`);
        }
        await tx("readwrite", (store) => store.delete(op.id));
        sent++;
      } catch {
        // Transport failure: still offline. Everything after this is untried.
        break;
      }
    }
  } catch (err) {
    console.warn("[outbox] drain failed", err);
  } finally {
    draining = false;
    await refreshCount();
  }
  return sent;
}

/**
 * Applies a queued change to a copy of the list, so the screen agrees with what
 * was asked for before the server has confirmed it.
 *
 * Kept here, next to the ops themselves, so a new op type cannot be added
 * without deciding what it looks like locally.
 */
export function applyLocally<T extends { id: string }>(items: T[], op: OutboxOp): T[] {
  switch (op.kind) {
    case "delete-item":
      return items.filter((i) => i.id !== op.itemId);
    case "patch-item":
      return items.map((i) => (i.id === op.itemId ? { ...i, ...op.body } : i));
    case "capture":
      // Nothing to show: the item does not exist until the server makes one,
      // and inventing a placeholder row with no title would be a worse lie
      // than the queue count already on screen.
      return items;
  }
}
