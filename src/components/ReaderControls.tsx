"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Theme = "light" | "sepia" | "dark";

const SCALES = [0.85, 0.925, 1, 1.1, 1.25, 1.45];
const WIDTHS = ["34rem", "40rem", "48rem"];

/**
 * Reader chrome: theme, text size, width, and mark-as-done.
 *
 * Preferences are per-device (a phone and a desktop want different sizes), so
 * they live in localStorage and are applied to <html> by the inline script in
 * the root layout — before first paint, so there is no flash of default type.
 * This component only edits them.
 */
export function ReaderControls({
  itemId,
  initialProgress,
  archived,
}: {
  itemId: string;
  initialProgress: number;
  archived: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useReadingProgress(itemId, initialProgress);

  async function toggleArchive() {
    await fetch(`/api/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: archived ? "unread" : "archived" }),
    });
    router.push("/");
    router.refresh();
  }

  return (
    <div className="no-print flex items-center gap-1">
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Display settings"
          className="grid h-9 w-9 place-items-center rounded-md hover:bg-[var(--bg-subtle)]"
          style={{ color: "var(--text-muted)" }}
        >
          Aa
        </button>

        {/* Mounted only on open, which is always after hydration — so the
            panel can read localStorage directly without an SSR mismatch. */}
        {open && <DisplayPanel onClose={() => setOpen(false)} />}
      </div>

      <button
        type="button"
        onClick={() => void toggleArchive()}
        className="rounded-md px-3 py-1.5 text-[13px] font-medium hover:bg-[var(--bg-subtle)]"
        style={{ color: "var(--text-muted)" }}
      >
        {archived ? "Requeue" : "Done"}
      </button>
    </div>
  );
}

function readIndex(key: string, max: number, fallback: number): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isInteger(raw) && raw >= 0 && raw < max ? raw : fallback;
}

function DisplayPanel({ onClose }: { onClose: () => void }) {
  // Lazy initialisers: this component never renders on the server.
  const [scaleIndex, setScaleIndex] = useState(() =>
    readIndex("rr:scale", SCALES.length, 2)
  );
  const [widthIndex, setWidthIndex] = useState(() =>
    readIndex("rr:width", WIDTHS.length, 0)
  );
  const [theme, setTheme] = useState<Theme | "">(
    () => (localStorage.getItem("rr:theme") as Theme) ?? ""
  );

  function applyScale(index: number) {
    setScaleIndex(index);
    document.documentElement.style.setProperty("--reader-scale", String(SCALES[index]));
    localStorage.setItem("rr:scale", String(index));
  }

  function applyWidth(index: number) {
    setWidthIndex(index);
    document.documentElement.style.setProperty("--reader-width", WIDTHS[index]);
    localStorage.setItem("rr:width", String(index));
  }

  function applyTheme(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("rr:theme", next);
  }

  return (
    <>
      {/* Click-away layer — simpler than a focus trap for a three-row menu. */}
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <div
        className="absolute right-0 z-30 mt-1 w-60 rounded-xl border p-3 shadow-lg"
        style={{ borderColor: "var(--border)", background: "var(--bg)" }}
      >
        <Row label="Text size">
          <Stepper
            onDown={() => applyScale(Math.max(0, scaleIndex - 1))}
            onUp={() => applyScale(Math.min(SCALES.length - 1, scaleIndex + 1))}
            downDisabled={scaleIndex === 0}
            upDisabled={scaleIndex === SCALES.length - 1}
          />
        </Row>

        <Row label="Width">
          <Stepper
            onDown={() => applyWidth(Math.max(0, widthIndex - 1))}
            onUp={() => applyWidth(Math.min(WIDTHS.length - 1, widthIndex + 1))}
            downDisabled={widthIndex === 0}
            upDisabled={widthIndex === WIDTHS.length - 1}
          />
        </Row>

        <Row label="Theme">
          <div className="flex gap-1">
            {(["light", "sepia", "dark"] as Theme[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => applyTheme(t)}
                aria-label={t}
                aria-pressed={theme === t}
                className="h-7 w-7 rounded-full border-2"
                /* Swatches are literal so each shows its own theme, not the
                   active one — keep in sync with globals.css. */
                style={{
                  background:
                    t === "light" ? "#faf9f5" : t === "sepia" ? "#f2e9d8" : "#1f1e1d",
                  borderColor: theme === t ? "var(--accent)" : "var(--border)",
                }}
              />
            ))}
          </div>
        </Row>
      </div>
    </>
  );
}

/**
 * Restores the saved scroll position on open, then saves it while scrolling
 * (throttled) and once on the way out.
 */
function useReadingProgress(itemId: string, initialProgress: number) {
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (initialProgress > 0.02 && initialProgress < 0.98) {
      const scrollable =
        document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: scrollable * initialProgress, behavior: "instant" });
    }
  }, [initialProgress]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest = initialProgress;

    const save = () => {
      // sendBeacon survives the page being closed; fetch would be cancelled.
      navigator.sendBeacon?.(
        `/api/items/${itemId}/progress`,
        new Blob([JSON.stringify({ progress: latest })], {
          type: "application/json",
        })
      );
    };

    const onScroll = () => {
      const scrollable =
        document.documentElement.scrollHeight - window.innerHeight;
      latest = scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        save();
      }, 2000);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      if (timer) clearTimeout(timer);
      save();
    };
  }, [itemId, initialProgress]);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Stepper({
  onDown,
  onUp,
  downDisabled,
  upDisabled,
}: {
  onDown: () => void;
  onUp: () => void;
  downDisabled: boolean;
  upDisabled: boolean;
}) {
  const cls =
    "grid h-7 w-7 place-items-center rounded-md border text-sm disabled:opacity-30";
  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={onDown}
        disabled={downDisabled}
        className={cls}
        style={{ borderColor: "var(--border)" }}
        aria-label="Decrease"
      >
        −
      </button>
      <button
        type="button"
        onClick={onUp}
        disabled={upDisabled}
        className={cls}
        style={{ borderColor: "var(--border)" }}
        aria-label="Increase"
      >
        +
      </button>
    </div>
  );
}
