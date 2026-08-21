"use client";

import { useCallback, useEffect, useState } from "react";
import { netFetch } from "@/lib/connectivity";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ShelfItem } from "@/lib/groups/access";

function timeAgo(date: Date): string {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 90) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * A group's shelf.
 *
 * Deliberately not the queue: nothing here is yours until you save it, nothing
 * reorders, and dismissing hides a card for you alone. The card is metadata
 * only — the article text lives in your own copy, after you save, which is why
 * no one's `contentHtml` ever crosses a user boundary.
 */
export function GroupShelf({
  groupId,
  groupName,
  initialShares,
}: {
  groupId: string;
  groupName: string;
  initialShares: ShelfItem[];
}) {
  const router = useRouter();
  const [shares, setShares] = useState(initialShares);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // No effect syncing `initialShares` into state: every mutation here refetches
  // explicitly, and the live event below covers everyone else's. Mirroring the
  // prop as well would be a second source of truth for the same list.
  const refetch = useCallback(async () => {
    // Called from an event listener as a floating promise, so a rejection here
    // was an unhandled one on every failure.
    try {
      const response = await netFetch(`/api/groups/${groupId}/shares`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = await response.json();
      setShares(body.shares ?? []);
    } catch {
      // Keep what is on screen; a group shelf is never cached offline anyway.
    }
  }, [groupId]);

  // Someone else sharing into this group should land without a reload. The
  // shelf listens only for its own event — an extraction finishing elsewhere is
  // none of its business.
  useEffect(() => {
    const source = new EventSource("/api/events");
    const onChange = () => void refetch();
    source.addEventListener("groups-changed", onChange);
    return () => {
      source.removeEventListener("groups-changed", onChange);
      source.close();
    };
  }, [refetch]);

  async function act(shareId: string, kind: "save" | "dismiss" | "unshare") {
    setBusy(shareId);
    setError(null);

    // Optimistic for the two that remove the card. Save leaves it in place —
    // it stays on the shelf as a record of what the group is reading, and the
    // card relabels itself to say it is now in your queue.
    const previous = shares;
    if (kind !== "save") setShares((rows) => rows.filter((r) => r.id !== shareId));

    try {
      const path =
        kind === "save"
          ? `/api/shares/${shareId}/save`
          : `/api/shares/${shareId}/dismiss${kind === "unshare" ? "?unshare=1" : ""}`;
      const response = await fetch(path, { method: "POST" });
      if (!response.ok) throw new Error("That didn't work");
      if (kind === "save") {
        await refetch();
        // The queue's own count in the header is server-rendered.
        router.refresh();
      }
    } catch (err) {
      setShares(previous);
      setError(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-3 pt-4 sm:px-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
          {groupName}
        </h1>
        <Link
          href="/groups"
          className="shrink-0 text-[13px] hover:underline"
          style={{ color: "var(--text-muted)" }}
        >
          All groups
        </Link>
      </div>

      {/* No paste box here on purpose. A shelf is meant to be things people
          actually chose to read, so a share starts from your own queue or
          archive — the Share control on a row, or in the reader. The server
          enforces it too; this is not just a hidden field. */}
      <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
        To add something, open your{" "}
        <Link href="/" className="underline">
          queue
        </Link>{" "}
        or{" "}
        <Link href="/archive" className="underline">
          archive
        </Link>{" "}
        and use Share on the article.
      </p>

      {error && (
        <p className="mt-2 text-[13px] text-red-600" role="alert">
          {error}
        </p>
      )}

      {shares.length === 0 ? (
        <p
          className="px-4 py-16 text-center text-sm"
          style={{ color: "var(--text-muted)" }}
        >
          Nothing on the shelf yet. Share something from your queue, or invite
          someone below.
        </p>
      ) : (
        <ul className="mt-6">
          {shares.map((share) => (
            <li
              key={share.id}
              className="border-b py-3"
              style={{ borderColor: "var(--border)" }}
            >
              <a
                href={share.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium hover:underline"
              >
                {share.title}
              </a>

              {share.excerpt && (
                <p
                  className="mt-1 line-clamp-2 text-[13px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {share.excerpt}
                </p>
              )}

              {share.note && (
                <p className="mt-1 text-[13px]" style={{ color: "var(--text)" }}>
                  &ldquo;{share.note}&rdquo;
                </p>
              )}

              <div
                className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[12px]"
                style={{ color: "var(--text-muted)" }}
              >
                {share.siteName && (
                  <>
                    <span className="truncate">{share.siteName}</span>
                    <span aria-hidden>·</span>
                  </>
                )}
                <span>
                  {share.sharedByMe ? "you" : share.sharedByEmail} ·{" "}
                  {timeAgo(share.sharedAt)}
                </span>

                <span className="ml-auto flex items-center gap-1">
                  {share.savedItemId ? (
                    <Link
                      href={`/read/${share.savedItemId}`}
                      className="rounded-md px-2 py-1 text-[13px] hover:bg-[var(--bg-subtle)]"
                      style={{ color: "var(--accent)" }}
                    >
                      {share.savedStatus === "archived"
                        ? "In your archive"
                        : "In your queue"}
                    </Link>
                  ) : (
                    <button
                      onClick={() => act(share.id, "save")}
                      disabled={busy === share.id}
                      className="rounded-md px-2 py-1 text-[13px] hover:bg-[var(--bg-subtle)] disabled:opacity-40"
                    >
                      Save
                    </button>
                  )}
                  <button
                    onClick={() => act(share.id, "dismiss")}
                    disabled={busy === share.id}
                    className="rounded-md px-2 py-1 text-[13px] hover:bg-[var(--bg-subtle)] disabled:opacity-40"
                    title="Hides it for you. Everyone else still sees it."
                  >
                    Dismiss
                  </button>
                  {share.sharedByMe && (
                    <button
                      onClick={() => act(share.id, "unshare")}
                      disabled={busy === share.id}
                      className="rounded-md px-2 py-1 text-[13px] text-red-600 hover:bg-red-500/10 disabled:opacity-40"
                      title="Takes it off the shelf for everyone."
                    >
                      Unshare
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
