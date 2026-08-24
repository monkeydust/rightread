"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ListItem } from "@/lib/items";
import {
  netFetch,
  isOnline,
  isNetworkError,
  subscribeConnectivity,
} from "@/lib/connectivity";
import { enqueue, applyLocally } from "@/lib/outbox";
import { ItemRow } from "@/components/ItemRow";
import { OmniBar } from "@/components/OmniBar";
import { SearchResults, type SearchPayload } from "@/components/SearchResults";
import { useOfflinePrecache } from "@/components/useOfflinePrecache";

type Props = {
  initialItems: ListItem[];
  status: "unread" | "archived";
  /**
   * Every item in the library, unread first — not just this page's.
   * See the note in useOfflinePrecache: the set is pruned to what it is given.
   */
  precacheIds: string[];
};

/**
 * Search over what the browser already holds.
 *
 * Offline the real search is unreachable — it is FTS5 and embeddings, both
 * server-side — and the box used to sit on "Searching…" for ever. This is the
 * honest substitute: the list in memory carries title, site and excerpt, so
 * those can be matched here. Article bodies never reach the client, so this
 * cannot pretend to be full-text, and the results header says so.
 */
function localSearch(items: ListItem[], term: string): SearchPayload {
  const needle = term.trim().toLowerCase();
  const exact = items
    .filter((i) =>
      [i.title, i.excerpt, i.siteName].some((field) =>
        field?.toLowerCase().includes(needle)
      )
    )
    .map((i) => ({
      id: i.id,
      url: i.url,
      title: i.title,
      siteName: i.siteName,
      kind: i.kind,
      status: i.status,
      savedAt: new Date(i.savedAt).toISOString(),
      wordCount: i.wordCount,
      snippet: i.excerpt,
    }));

  return {
    query: term,
    hasWildcard: false,
    exact,
    semantic: [],
    // Not "unavailable" as an error — offline it is genuinely just absent, and
    // the panel already knows how to say nothing rather than complain.
    semanticStatus: "skipped",
    tookMs: 0,
  };
}

/**
 * Fields whose value is absolute, and so safe to queue and replay later.
 *
 * `retry` is absent on purpose: it asks the server to go and fetch a page, which
 * is the one thing that cannot be done from a queue, and replaying it an hour
 * later against an item that has since extracted would be pointless work.
 * `move` is absent because it is relative — see the note in lib/outbox.ts.
 */
const QUEUEABLE = new Set(["starred", "status", "kind", "progress"]);

export function Library({ initialItems, status, precacheIds }: Props) {
  // Callers pass key={status}, so switching tabs remounts this with the right
  // server data rather than syncing props into state.
  const [items, setItems] = useState(initialItems);

  // The whole library, from either page. The archive used to be excluded on the
  // grounds that it is what you have finished with — but "finished with" is not
  // the same as "never want to look at again", and excluding it meant a plane
  // journey could not reach a single archived article.
  useOfflinePrecache(precacheIds, true);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set by OmniBar, which decides whether what was typed is a search or a
  // link. Empty whenever the box is holding a link.
  const [searchTerm, setSearchTerm] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  // Results carry the term they belong to. That makes "is this stale?" a
  // derived question rather than something to clear imperatively — clearing
  // state in an effect body causes a cascading render, and leaving it uncleared
  // would flash the previous query's hits while the next one loads.
  const [results, setResults] = useState<{
    term: string;
    payload: SearchPayload;
  } | null>(null);

  // Reachability, so the doomed requests below can simply not be made.
  const online = useSyncExternalStore(subscribeConnectivity, isOnline, () => true);

  const refresh = useCallback(async () => {
    // Had no catch at all, and is called as `void refresh()` from the stream
    // listener and the poller — so every failure offline was an unhandled
    // rejection, several times a minute.
    try {
      const res = await netFetch(`/api/items?status=${status}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.items);
    } catch {
      // Nothing to say: the list on screen is still the best copy we have, and
      // the indicator in the header already reports the connection.
    }
  }, [status]);

  // ── Live updates ────────────────────────────────────────────────
  // The server pushes when background work lands (extraction, then
  // classification) and when another device edits something. The browser
  // reconnects an EventSource on its own, so a dropped connection heals.
  const [liveConnected, setLiveConnected] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    // Offline an EventSource reconnects roughly every 3s for the life of the
    // tab, and on a network that stalls rather than refuses each attempt holds
    // a socket for the OS timeout. Twenty of those exhaust the per-origin
    // connection pool, at which point even a request the cache could answer
    // queues behind dead sockets — which is a large part of why the app
    // appeared frozen rather than merely offline.
    if (!online) return;

    const source = new EventSource("/api/events");
    source.onopen = () => setLiveConnected(true);
    source.addEventListener("items-changed", () => void refresh());
    source.onerror = () => {
      // Fires on transient drops too, and EventSource retries by itself.
      // Flipping this false re-arms the polling fallback for the gap.
      setLiveConnected(false);
    };

    return () => {
      setLiveConnected(false);
      source.close();
    };
  }, [refresh, online]);

  /*
   * Refetch when the app comes back to the foreground.
   *
   * Nothing else asks. An installed PWA that has been backgrounded keeps its
   * React state, its EventSource may have been dropped while it was away, and
   * the polling fallback below only runs while something is still extracting —
   * so a settled queue simply never updated. Save a page from the share sheet,
   * reopen the app, and the article you just saved was not there until you
   * pulled to refresh.
   *
   * refresh() is already timeout-bounded and already swallows its own failures,
   * so this is a trigger rather than new machinery.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // A phone in a pocket costs nothing; a doomed request offline costs a
      // socket held open for the OS timeout.
      if (!isOnline()) return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // Polling fallback, only while the stream is down. A proxy that buffers, a
  // service worker that intercepts, or a browser without EventSource would
  // otherwise leave the queue silently stale — so the old mechanism stays as
  // the safety net rather than being deleted.
  const settling = items.some(
    (i) => i.extractStatus === "pending" || i.kindSource === "none"
  );

  /*
   * The 90s bound, kept outside the effect.
   *
   * It used to be computed inside, so every re-run started a fresh 90 seconds
   * — and `liveConnected` flips false on every stream error, which offline is
   * about every 3 seconds. The "bounded" fallback was therefore unbounded
   * exactly when it was doing the most damage: a request every 2s for as long
   * as the tab stayed open.
   */
  const pollDeadline = useRef<number | null>(null);

  // Cleared when the queue stops settling, so the next burst of background work
  // gets a fresh 90 seconds. In an effect because a ref must not be written
  // during render.
  useEffect(() => {
    if (!settling) pollDeadline.current = null;
  }, [settling]);

  useEffect(() => {
    if (liveConnected || !settling) return;
    // No point polling a server we cannot reach; the stream will resume and
    // refresh once the connection is back.
    if (!online) return;

    if (pollDeadline.current === null) pollDeadline.current = Date.now() + 90_000;
    const id = setInterval(() => {
      if (pollDeadline.current !== null && Date.now() > pollDeadline.current) {
        clearInterval(id);
        return;
      }
      void refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [liveConnected, settling, refresh, online]);

  const mutate = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyId(id);
      setError(null);

      const queueable = Object.keys(body).every((k) => QUEUEABLE.has(k));

      /**
       * Take the change now and send it later.
       *
       * The row updates immediately, which is the point: a star that does
       * nothing until you land is indistinguishable from a broken button.
       */
      const queueIt = async () => {
        const op = { kind: "patch-item" as const, itemId: id, body };
        setItems((current) => applyLocally(current, op));
        await enqueue(op);
      };

      if (!online) {
        if (queueable) await queueIt();
        else
          setError(
            "That needs a connection — it'll work again when you're back online."
          );
        setBusyId(null);
        return;
      }

      try {
        const res = await netFetch(`/api/items/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Something went wrong");
        }
        await refresh();
      } catch (err) {
        // Went offline mid-request. Same treatment as having been offline all
        // along — the browser's own "Failed to fetch" tells a reader nothing.
        if (isNetworkError(err) && queueable) {
          await queueIt();
        } else {
          setError(
            isNetworkError(err)
              ? "You're offline — that one needs a connection."
              : err instanceof Error
                ? err.message
                : "Something went wrong"
          );
        }
      } finally {
        setBusyId(null);
      }
    },
    [refresh, online]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      // Optimistic: deletion is the one action where waiting feels broken.
      const previous = items;
      setItems((current) => current.filter((i) => i.id !== id));
      try {
        if (!online) {
          // Already removed from the list above; record it and stop.
          await enqueue({ kind: "delete-item", itemId: id });
          return;
        }
        const res = await netFetch(`/api/items/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Could not delete");
      } catch (err) {
        if (isNetworkError(err)) {
          await enqueue({ kind: "delete-item", itemId: id });
          return;
        }
        setItems(previous);
        setError(err instanceof Error ? err.message : "Could not delete");
      } finally {
        setBusyId(null);
      }
    },
    [items, online]
  );

  /*
   * The results to show.
   *
   * Offline this is *derived* rather than fetched-and-stored: the list is
   * already in memory, so a local match is a pure function of it, and deriving
   * avoids both a pointless request and a synchronous setState in an effect.
   * It also means `searching` can never be stuck true offline — which is what
   * left the box reading "Searching…" for ever.
   */
  const current = useMemo(() => {
    if (!searchTerm) return null;
    if (!online) return localSearch(items, searchTerm);
    return results?.term === searchTerm ? results.payload : null;
  }, [searchTerm, online, items, results]);

  const searching = searchTerm !== "" && current === null;

  useEffect(() => {
    if (!searchTerm) return;

    // Offline there is nothing to request; the answer is derived below from the
    // list already in memory.
    if (!online) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const q = encodeURIComponent(searchTerm);
      try {
        // Two stages, not one payload: keyword results are ~ms of SQLite and
        // render the moment they land, while the semantic group — which waits
        // on an embedding round trip — fills in afterwards. Bundling them
        // meant the fast half arrived at the speed of the slow half.
        const res = await fetch(`/api/search?q=${q}&mode=exact`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("search failed");
        const exactPayload = await res.json();
        setResults({
          term: searchTerm,
          payload: { ...exactPayload, semantic: [], semanticStatus: "pending" },
        });

        // Sequential on purpose: the exclude list needs the keyword ids, and
        // this request's time is dominated by the embedding call — starting it
        // ~20ms later is invisible, keeping the dedupe exact is not.
        const exclude = exactPayload.exact
          .map((h: { id: string }) => h.id)
          .join(",");
        const semRes = await fetch(
          `/api/search?q=${q}&mode=semantic&exclude=${exclude}`,
          { signal: controller.signal }
        );
        const sem = semRes.ok
          ? await semRes.json()
          : { semantic: [], semanticStatus: "unavailable" };
        // Functional update guarded by term: if the query changed while the
        // semantic half was in flight, its results belong to a dead search.
        setResults((prev) =>
          prev && prev.term === searchTerm
            ? {
                term: searchTerm,
                payload: {
                  ...prev.payload,
                  semantic: sem.semantic,
                  semanticStatus: sem.semanticStatus,
                },
              }
            : prev
        );
      } catch (err) {
        // An abort is the expected outcome of typing another character.
        if ((err as Error)?.name === "AbortError") return;

        /*
         * Resolve into a result, always.
         *
         * This used to set an error and stop, leaving `results` null — and
         * because `searching` is derived as "a term with no results yet", the
         * panel then rendered "Searching…" for ever, underneath a red "Search
         * failed". Two contradictory statements, neither of which ever
         * resolved, and the only escape was emptying the box.
         */
        if (isNetworkError(err)) {
          setResults({ term: searchTerm, payload: localSearch(items, searchTerm) });
        } else {
          setError("Search failed");
          setResults({
            term: searchTerm,
            payload: {
              query: searchTerm,
              hasWildcard: false,
              exact: [],
              semantic: [],
              semanticStatus: "unavailable",
              tookMs: 0,
            },
          });
        }
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchTerm, online, items]);

  const starredCount = useMemo(
    () => items.filter((i) => i.starred).length,
    [items]
  );

  const filtered = useMemo(
    () => (starredOnly ? items.filter((i) => i.starred) : items),
    [items, starredOnly]
  );

  // Ends of the real queue, not of the filtered view: moving an item while a
  // filter is applied still reorders it against everything, so disabling the
  // arrows on the first *visible* row would be a lie.
  const edges = useMemo(() => {
    const first = items[0]?.id;
    const last = items[items.length - 1]?.id;
    return { first, last };
  }, [items]);

  return (
    <div>
      <OmniBar
        onSaved={refresh}
        onSearchTermChange={setSearchTerm}
        starredCount={starredCount}
        starredOnly={starredOnly}
        onToggleStarred={() => setStarredOnly((v) => !v)}
      />

      {error && (
        <p className="px-4 py-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {searchTerm ? (
        <SearchResults results={current} loading={searching} offline={!online} />
      ) : filtered.length === 0 ? (
        <p
          className="px-4 py-16 text-center text-sm"
          style={{ color: "var(--text-muted)" }}
        >
          {starredOnly
            ? "Nothing starred yet."
            : status === "archived"
              ? "Nothing archived yet."
              : "Nothing saved yet. Paste a link in the box above, or share one to rightread."}
        </p>
      ) : (
        <ul style={{ borderTop: "1px solid var(--border)" }}>
          {filtered.map((item) => {
            return (
              <ItemRow
                key={item.id}
                item={item}
                isFirst={item.id === edges.first}
                isLast={item.id === edges.last}
                busy={busyId === item.id}
                onMove={(id, move) => void mutate(id, { move })}
                onStar={(id, starred) => void mutate(id, { starred })}
                onKind={(id, kind) => void mutate(id, { kind })}
                onArchive={(id, archived) =>
                  void mutate(id, { status: archived ? "archived" : "unread" })
                }
                onDelete={(id) => void handleDelete(id)}
                onRetry={(id) => void mutate(id, { retry: true })}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
