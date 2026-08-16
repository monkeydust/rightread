"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ListItem } from "@/lib/items";
import { ItemRow } from "@/components/ItemRow";
import { OmniBar } from "@/components/OmniBar";
import { SearchResults, type SearchPayload } from "@/components/SearchResults";
import { useOfflinePrecache } from "@/components/useOfflinePrecache";

type Props = {
  initialItems: ListItem[];
  status: "unread" | "archived";
};

export function Library({ initialItems, status }: Props) {
  // Callers pass key={status}, so switching tabs remounts this with the right
  // server data rather than syncing props into state.
  const [items, setItems] = useState(initialItems);

  // Only the unread queue — the archive is what you have finished with, and
  // spending someone's data to pull it down would be backwards.
  useOfflinePrecache(
    items.map((item) => item.id),
    status === "unread"
  );

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

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/items?status=${status}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setItems(data.items);
  }, [status]);

  // ── Live updates ────────────────────────────────────────────────
  // The server pushes when background work lands (extraction, then
  // classification) and when another device edits something. The browser
  // reconnects an EventSource on its own, so a dropped connection heals.
  const [liveConnected, setLiveConnected] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

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
  }, [refresh]);

  // Polling fallback, only while the stream is down. A proxy that buffers, a
  // service worker that intercepts, or a browser without EventSource would
  // otherwise leave the queue silently stale — so the old mechanism stays as
  // the safety net rather than being deleted.
  const settling = items.some(
    (i) => i.extractStatus === "pending" || i.kindSource === "none"
  );

  useEffect(() => {
    if (liveConnected || !settling) return;

    // Bounded on purpose. A classification that never resolves — no API key,
    // an upstream outage — leaves kindSource "none" permanently, and an
    // unbounded interval would then poll for the entire life of the tab.
    const deadline = Date.now() + 90_000;
    const id = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(id);
        return;
      }
      void refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [liveConnected, settling, refresh]);

  const mutate = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyId(id);
      setError(null);
      try {
        const res = await fetch(`/api/items/${id}`, {
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
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      // Optimistic: deletion is the one action where waiting feels broken.
      const previous = items;
      setItems((current) => current.filter((i) => i.id !== id));
      try {
        const res = await fetch(`/api/items/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Could not delete");
      } catch (err) {
        setItems(previous);
        setError(err instanceof Error ? err.message : "Could not delete");
      } finally {
        setBusyId(null);
      }
    },
    [items]
  );

  const current = results?.term === searchTerm ? results.payload : null;
  const searching = searchTerm !== "" && current === null;

  useEffect(() => {
    if (!searchTerm) return;
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
        if ((err as Error)?.name !== "AbortError") setError("Search failed");
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchTerm]);

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
        <SearchResults results={current} loading={searching} />
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
