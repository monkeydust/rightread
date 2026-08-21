"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isOnline, subscribeConnectivity } from "@/lib/connectivity";
import { pendingCount, subscribeOutbox } from "@/lib/outbox";

/**
 * A quiet mark that the app cannot reach the server.
 *
 * Renders nothing at all when online, which is almost always — an indicator
 * that is present but green is permanent furniture reporting the unremarkable.
 * It sits in the header's existing action row, so appearing costs no vertical
 * space and shifts no article off the screen.
 *
 * Not red. Being offline is a state this app is designed for, not a fault, and
 * the reader should feel told rather than warned.
 */
export function OfflineDot() {
  // useSyncExternalStore rather than an effect: connectivity is an external
  // store, this is what the hook is for, and it gets the server snapshot right
  // — the server always renders the online case, which is nothing at all, so
  // there is no hydration mismatch and no flash of a dot on every page load.
  const online = useSyncExternalStore(
    subscribeConnectivity,
    isOnline,
    () => true
  );
  // Changes made offline that the server has not heard yet. Worth showing even
  // once the connection is back: for the seconds it takes to drain, "there are
  // three things still to send" is the honest state.
  const pending = useSyncExternalStore(subscribeOutbox, pendingCount, () => 0);

  if (online && pending === 0) return null;
  // Mounted only while there is something to say, so the panel's open state
  // resets between outages rather than reappearing from a previous one.
  return <OfflineBadge online={online} pending={pending} />;
}

function OfflineBadge({ online, pending }: { online: boolean; pending: number }) {
  const [open, setOpen] = useState(false);
  const dotRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (dotRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // A document listener rather than a full-screen overlay: the header sets
    // backdrop-blur, which makes it a containing block for fixed-position
    // descendants, so an overlay would cover only the header strip. The same
    // trap is documented on the reader's display panel.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className="relative flex items-center">
      <button
        ref={dotRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          online
            ? `Sending ${pending} saved change${pending === 1 ? "" : "s"}`
            : "Offline. What still works?"
        }
        title={online ? "Sending your changes" : "Offline"}
        className="grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-[var(--bg-subtle)]"
      >
        <span
          aria-hidden
          // Pulsing only while actually sending — a pulse that never stops is
          // just movement, and this app keeps animation for work in progress.
          className={`block h-2 w-2 rounded-full ${online ? "animate-pulse" : ""}`}
          style={{ background: online ? "var(--accent)" : "var(--text-muted)" }}
        />
      </button>

      {open && (
        <div
          role="status"
          className="absolute right-0 top-full z-20 mt-1 w-60 rounded-lg border p-3 text-[13px] shadow-lg"
          style={{
            background: "var(--bg)",
            borderColor: "var(--border)",
            color: "var(--text-muted)",
          }}
        >
          <p style={{ color: "var(--text)" }} className="font-medium">
            {online ? "Catching up" : "You're offline"}
          </p>
          {pending > 0 && (
            <p className="mt-1.5">
              {pending} change{pending === 1 ? "" : "s"}{" "}
              {online ? "still to send." : "saved here, waiting to send."}
            </p>
          )}
          {!online && (
            <>
              <p className="mt-1.5">
                Saved articles are still readable, and anything you change is
                kept and sent when you&apos;re back.
              </p>
              <p className="mt-1.5">
                Search covers titles only, and groups and new links need a
                connection.
              </p>
            </>
          )}
        </div>
      )}
    </span>
  );
}
