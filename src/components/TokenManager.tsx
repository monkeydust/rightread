"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Token = {
  id: string;
  name: string;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export function TokenManager({ tokens }: { tokens: Token[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // Held in memory only — once this page is left, the plaintext is gone.
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || "Browser extension" }),
      });
      const data = await res.json();
      if (res.ok) {
        setFresh({ token: data.token, name: data.name });
        setName("");
        router.refresh();
      }
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/tokens?id=${id}`, { method: "DELETE" });
    router.refresh();
  }

  async function copy() {
    if (!fresh) return;
    await navigator.clipboard.writeText(fresh.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <section>
      <h2 className="text-sm font-semibold">Capture tokens</h2>
      <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
        The browser extension uses one of these to save links. Create one per
        device so you can revoke them individually.
      </p>

      {fresh && (
        <div
          className="mt-3 rounded-lg border p-3"
          style={{ borderColor: "var(--border)", background: "var(--bg-subtle)" }}
        >
          <p className="text-[13px] font-medium">
            Copy this now — it won&apos;t be shown again.
          </p>
          <div className="mt-2 flex gap-2">
            <code
              className="min-w-0 flex-1 overflow-x-auto rounded-md border px-2 py-1.5 text-[12px]"
              style={{ borderColor: "var(--border)", background: "var(--bg)" }}
            >
              {fresh.token}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              className="shrink-0 rounded-md px-3 py-1.5 text-[13px] font-medium"
              style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={create} className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Device name (e.g. Edge on desktop)"
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        <button
          type="submit"
          disabled={creating}
          className="shrink-0 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
          style={{ borderColor: "var(--border)" }}
        >
          {creating ? "…" : "New token"}
        </button>
      </form>

      {tokens.length > 0 && (
        <ul className="mt-3">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between border-b py-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0">
                <p className="truncate">{t.name}</p>
                <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {t.lastUsedAt
                    ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                    : "never used"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void revoke(t.id)}
                className="shrink-0 rounded-md px-2 py-1 text-[13px] text-red-600 hover:bg-red-500/10"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
