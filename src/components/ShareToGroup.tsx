"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { GroupSummary } from "@/lib/groups/access";

type State = "idle" | "loading" | "error";

/**
 * Puts the article you are reading on a group's shelf.
 *
 * Groups are fetched when the panel opens rather than passed down from the
 * page: the reader is the hot path in this app and most article opens never
 * touch this button, so making every one of them pay for a groups query would
 * be the wrong trade.
 *
 * Sharing sends the URL, not the extracted text. The shelf builds its own
 * snapshot from your copy, and each member who saves it extracts their own —
 * no one's `contentHtml` crosses a user boundary.
 */
export function ShareToGroup({ url, title }: { url: string; title: string }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Share “${title}” with a group`}
        className="rounded-md px-2 py-1.5 text-[13px] font-medium hover:bg-[var(--bg-subtle)]"
        style={{ color: "var(--text-muted)" }}
      >
        Share
      </button>

      {open && (
        <SharePanel url={url} onClose={() => setOpen(false)} toggleRef={toggleRef} />
      )}
    </div>
  );
}

function SharePanel({
  url,
  onClose,
  toggleRef,
}: {
  url: string;
  onClose: () => void;
  toggleRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [state, setState] = useState<State>("loading");
  const [shared, setShared] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/groups", { cache: "no-store" });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (cancelled) return;
        setGroups(body.groups ?? []);
        setState("idle");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on a click outside, and on Escape. A `fixed inset-0` overlay does not
  // work here: the reader header uses backdrop-blur, which makes it a
  // containing block for fixed descendants, so the overlay would cover only the
  // header strip. Same fix as the display panel.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, toggleRef]);

  async function share(groupId: string) {
    setBusy(groupId);
    try {
      const response = await fetch(`/api/groups/${groupId}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) throw new Error();
      setShared((s) => ({ ...s, [groupId]: true }));
    } catch {
      setState("error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border p-1.5 shadow-lg"
      style={{ background: "var(--bg)", borderColor: "var(--border)" }}
    >
      {state === "loading" && (
        <p className="px-2 py-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Loading your groups…
        </p>
      )}

      {state === "error" && (
        <p className="px-2 py-3 text-[13px] text-red-600" role="alert">
          That didn&apos;t work. Try again.
        </p>
      )}

      {state === "idle" && groups?.length === 0 && (
        <div className="px-2 py-3">
          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            You&apos;re not in a group yet.
          </p>
          <Link href="/groups" className="mt-1 block text-[13px] underline">
            Create one
          </Link>
        </div>
      )}

      {state === "idle" && groups && groups.length > 0 && (
        <>
          <p
            className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            Share with
          </p>
          <ul>
            {groups.map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  onClick={() => void share(group.id)}
                  disabled={busy === group.id || shared[group.id]}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-[var(--bg-subtle)] disabled:opacity-100"
                >
                  <span className="min-w-0 truncate">{group.name}</span>
                  <span
                    className="shrink-0 text-[12px]"
                    style={{
                      color: shared[group.id] ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {shared[group.id] ? "Shared ✓" : busy === group.id ? "…" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
