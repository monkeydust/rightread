"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { hostLabel } from "@/lib/url";

type Source = {
  id: string;
  feedUrl: string;
  title: string | null;
  active: boolean;
  lastFetchedAt: Date | null;
  lastError: string | null;
  candidateCount: number;
};

export function SourceManager({ sources }: { sources: Source[] }) {
  const router = useRouter();
  const [feedUrl, setFeedUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedUrl }),
      });
      const data = await res.json();
      if (res.ok) {
        setFeedUrl("");
        router.refresh();
      } else {
        setError(data.error ?? "Could not add that feed");
      }
    } finally {
      setAdding(false);
    }
  }

  async function toggle(id: string, active: boolean) {
    await fetch(`/api/sources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    router.refresh();
  }

  async function remove(id: string) {
    await fetch(`/api/sources/${id}`, { method: "DELETE" });
    router.refresh();
  }

  async function refreshAll() {
    setRefreshing(true);
    try {
      await fetch("/api/sources/refresh", { method: "POST" });
      // The sweep runs in the background; counts update as it progresses.
      router.refresh();
    } finally {
      setTimeout(() => setRefreshing(false), 1500);
    }
  }

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Recommendation sources</h2>
        {sources.length > 0 && (
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={refreshing}
            className="text-[12px] font-medium hover:underline disabled:opacity-40"
            style={{ color: "var(--text-muted)" }}
          >
            {refreshing ? "Checking…" : "Check feeds now"}
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
        RSS or Atom feeds you trust. After you finish an article, similar pieces
        from these feeds — and only these — appear beneath it. Feeds are checked
        every 15 minutes.
      </p>

      <form onSubmit={add} className="mt-3 flex gap-2">
        <input
          value={feedUrl}
          onChange={(e) => setFeedUrl(e.target.value)}
          placeholder="Feed URL (e.g. example.com/rss.xml)"
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        <button
          type="submit"
          disabled={adding || !feedUrl.trim()}
          className="shrink-0 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
          style={{ borderColor: "var(--border)" }}
        >
          {adding ? "…" : "Add feed"}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-[13px] text-red-600" role="alert">
          {error}
        </p>
      )}

      {sources.length > 0 && (
        <ul className="mt-3">
          {sources.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 border-b py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0">
                <p className="truncate" style={{ opacity: s.active ? 1 : 0.5 }}>
                  {s.title || hostLabel(s.feedUrl)}
                </p>
                <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {s.lastError ? (
                    <span className="text-red-600">{s.lastError}</span>
                  ) : s.lastFetchedAt ? (
                    <>
                      {s.candidateCount} article{s.candidateCount === 1 ? "" : "s"}
                      {" · checked "}
                      {new Date(s.lastFetchedAt).toLocaleString(undefined, {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </>
                  ) : (
                    "checking…"
                  )}
                  {!s.active && " · paused"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void toggle(s.id, !s.active)}
                  className="rounded-md px-2 py-1 text-[13px] hover:bg-[var(--bg-subtle)]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {s.active ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(s.id)}
                  className="rounded-md px-2 py-1 text-[13px] text-red-600 hover:bg-red-500/10"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
