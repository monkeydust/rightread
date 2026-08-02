"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ListItem } from "@/lib/items";
import { ItemRow } from "@/components/ItemRow";
import { AddLink } from "@/components/AddLink";
import { Star } from "@/components/icons";

type Props = {
  initialItems: ListItem[];
  status: "unread" | "archived";
};

export function Library({ initialItems, status }: Props) {
  // Callers pass key={status}, so switching tabs remounts this with the right
  // server data rather than syncing props into state.
  const [items, setItems] = useState(initialItems);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/items?status=${status}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setItems(data.items);
  }, [status]);

  // Freshly captured items extract in the background — poll until they settle.
  const pending = items.some((i) => i.extractStatus === "pending");

  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [pending, refresh]);

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

  const starredCount = useMemo(
    () => items.filter((i) => i.starred).length,
    [items]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (starredOnly && !i.starred) return false;
      if (!q) return true;
      return (
        i.title.toLowerCase().includes(q) ||
        (i.siteName ?? "").toLowerCase().includes(q) ||
        i.url.toLowerCase().includes(q) ||
        (i.excerpt ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, query, starredOnly]);

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
      {status === "unread" && <AddLink onSaved={refresh} />}

      {(items.length > 6 || starredCount > 0) && (
        <div className="flex gap-2 px-3 pb-2 sm:px-4">
          {items.length > 6 && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--border)" }}
            />
          )}
          {starredCount > 0 && (
            <button
              type="button"
              onClick={() => setStarredOnly((v) => !v)}
              aria-pressed={starredOnly}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors"
              style={{
                borderColor: starredOnly ? "var(--accent)" : "var(--border)",
                color: starredOnly ? "var(--accent)" : "var(--text-muted)",
              }}
            >
              <Star size={15} filled={starredOnly} />
              {starredCount}
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="px-4 py-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {filtered.length === 0 ? (
        <p
          className="px-4 py-16 text-center text-sm"
          style={{ color: "var(--text-muted)" }}
        >
          {starredOnly
            ? "Nothing starred matches."
            : query
            ? "Nothing matches that filter."
            : status === "archived"
              ? "Nothing archived yet."
              : "Nothing saved yet. Share a link here, or paste one above."}
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
