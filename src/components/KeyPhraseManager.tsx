"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Phrase = {
  id: string;
  text: string;
  active: boolean;
  embeddedAt: Date | null;
  lastMatchedAt: Date | null;
};

export function KeyPhraseManager({ phrases }: { phrases: Phrase[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/phrases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (res.ok) {
        setText("");
        router.refresh();
      } else {
        setError(data.error ?? "Could not add that phrase");
      }
    } finally {
      setAdding(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/phrases/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    router.refresh();
  }

  async function remove(id: string) {
    await fetch(`/api/phrases/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-sm font-semibold">Key phrases</h2>
      <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
        Topics you want brought to you. Each one is matched against everything
        your sources publish, by meaning rather than by keyword — so
        &ldquo;running models on your own hardware&rdquo; finds an article that
        never uses those words. Results appear under Discover.
      </p>

      <form onSubmit={add} className="mt-3 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. post-quantum cryptography"
          maxLength={200}
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        <button
          type="submit"
          disabled={adding || !text.trim()}
          className="shrink-0 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
          style={{ borderColor: "var(--border)" }}
        >
          {adding ? "…" : "Add phrase"}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-[13px] text-red-600" role="alert">
          {error}
        </p>
      )}

      {phrases.length > 0 && (
        <ul className="mt-3">
          {phrases.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 border-b py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              {editing === p.id ? (
                <form
                  className="flex min-w-0 flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setEditing(null);
                    if (draft.trim() && draft.trim() !== p.text) {
                      void patch(p.id, { text: draft.trim() });
                    }
                  }}
                >
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => setEditing(null)}
                    maxLength={200}
                    className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-sm outline-none"
                    style={{ borderColor: "var(--accent)" }}
                  />
                </form>
              ) : (
                <div className="min-w-0">
                  <p className="truncate" style={{ opacity: p.active ? 1 : 0.5 }}>
                    {p.text}
                  </p>
                  <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {!p.embeddedAt
                      ? "preparing…"
                      : p.lastMatchedAt
                        ? `checked ${new Date(p.lastMatchedAt).toLocaleString(undefined, {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}`
                        : "waiting for the next check"}
                    {!p.active && " · paused"}
                  </p>
                </div>
              )}

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setDraft(p.text);
                    setEditing(p.id);
                  }}
                  className="rounded-md px-2 py-1 text-[13px] hover:bg-[var(--bg-subtle)]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void patch(p.id, { active: !p.active })}
                  className="rounded-md px-2 py-1 text-[13px] hover:bg-[var(--bg-subtle)]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {p.active ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(p.id)}
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
