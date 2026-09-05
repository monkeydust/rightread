"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Working } from "@/components/Working";

/**
 * Browser-sourced capture: paste a page rightread could not fetch.
 *
 * For pages a server cannot reach but you can — a paywalled article you are
 * logged into, or one behind a bot check you passed in your own browser. You
 * read it, select it, copy, and paste here; your browser hands over the HTML it
 * already has and the server extracts from that. Nothing touches the origin.
 *
 * The paste is read as text/html when the browser offers it (copied web content
 * almost always does), which keeps paragraph structure so Readability can work.
 * Plain text is the fallback, wrapped one paragraph per line.
 */
export function PasteCapture({
  itemId,
  title,
  onClose,
  onDone,
}: {
  itemId: string;
  title: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [captured, setCaptured] = useState<{ html: string; chars: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Focus the drop zone so a paste keystroke lands here immediately.
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  // Escape closes, matching the reader's Aa panel and every other overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");

    if (html && html.trim()) {
      setCaptured({ html, chars: html.length });
    } else if (text && text.trim()) {
      // No rich HTML — rebuild rough structure so Readability has paragraphs.
      const paras = text
        .split(/\n{2,}|\r\n\r\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join("\n");
      setCaptured({ html: `<article>${paras}</article>`, chars: text.length });
    } else {
      setError("That paste was empty — copy the article first, then paste.");
    }
  }

  async function submit() {
    if (!captured) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: captured.html }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not read that page");
      }
      router.refresh();
      onDone?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center"
      style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-xl border p-4 shadow-xl"
        style={{ borderColor: "var(--border)", background: "var(--bg)" }}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
          Paste this page
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          For <span style={{ color: "var(--text)" }}>{title}</span> — a page we
          couldn&apos;t fetch but you can read. Open it in your browser, select
          the article (Select all is fine), copy, then paste below.
        </p>

        {captured ? (
          <div
            className="mt-3 rounded-lg border px-3 py-3 text-[13px]"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            Captured {Math.round(captured.chars / 1000).toLocaleString()}KB of page
            content. Extract it into a clean article?
            <button
              type="button"
              onClick={() => setCaptured(null)}
              className="ml-2 underline hover:no-underline"
            >
              paste again
            </button>
          </div>
        ) : (
          <div
            ref={boxRef}
            tabIndex={0}
            contentEditable
            suppressContentEditableWarning
            onPaste={onPaste}
            role="textbox"
            aria-label="Paste the copied page here"
            className="mt-3 min-h-24 rounded-lg border px-3 py-3 text-[13px] outline-none"
            style={{
              borderColor: "var(--border)",
              color: "var(--text-muted)",
              caretColor: "var(--accent)",
            }}
            data-placeholder="Paste here"
          />
        )}

        {error && (
          <p className="mt-2 text-[13px] text-red-600" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm hover:bg-[var(--bg-subtle)]"
            style={{ color: "var(--text-muted)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!captured || busy}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
              busy ? "" : "disabled:opacity-40"
            }`}
            style={{
              borderColor: "var(--accent)",
              background: "var(--accent)",
              color: "var(--accent-ink)",
            }}
          >
            {busy && <Working />}
            {busy ? "Extracting…" : "Extract"}
          </button>
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
