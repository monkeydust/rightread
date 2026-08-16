"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { GroupSummary } from "@/lib/groups/access";

/**
 * The groups index: what I'm in, and a box to start another.
 *
 * Same shape as SourceManager and the other settings sections — fetch, then
 * `router.refresh()` to re-run the server page rather than syncing local state.
 */
export function GroupList({ groups }: { groups: GroupSummary[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || creating) return;

    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error ?? "Could not create that group");
      }
      setName("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that group");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="px-3 pb-16 sm:px-4">
      <form onSubmit={create} className="mt-4 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New group — e.g. Reading club"
          aria-label="New group name"
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="shrink-0 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
          style={{ borderColor: "var(--border)" }}
        >
          {creating ? "…" : "Create"}
        </button>
      </form>

      {error && (
        <p className="mt-2 text-[13px] text-red-600" role="alert">
          {error}
        </p>
      )}

      {groups.length === 0 ? (
        <p
          className="px-4 py-16 text-center text-sm"
          style={{ color: "var(--text-muted)" }}
        >
          No groups yet. Create one above, then invite someone by email.
        </p>
      ) : (
        <ul className="mt-6">
          {groups.map((group) => (
            <li
              key={group.id}
              className="border-b"
              style={{ borderColor: "var(--border)" }}
            >
              <Link
                href={`/groups/${group.id}`}
                className="flex items-baseline justify-between gap-3 py-3 transition-colors hover:bg-[var(--bg-subtle)]"
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium">{group.name}</span>
                  <span
                    className="ml-2 text-[12px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {group.memberCount === 1
                      ? "just you"
                      : `${group.memberCount} members`}
                  </span>
                </span>
                <span
                  className="shrink-0 text-[12px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {group.shelfCount === 0
                    ? "empty"
                    : `${group.shelfCount} on the shelf`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
