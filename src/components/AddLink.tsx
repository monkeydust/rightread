"use client";

import { useState } from "react";

/** Paste box — the desktop path when the extension isn't installed. */
export function AddLink({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || saving) return;

    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save that link");

      setUrl("");
      setMessage(data.alreadySaved ? "Already saved — moved to top" : null);
      await onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save that link");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="px-3 py-3 sm:px-4">
      <div className="flex gap-2">
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a link…"
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        <button
          type="submit"
          disabled={!url.trim() || saving}
          className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {message && (
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {message}
        </p>
      )}
    </form>
  );
}
