"use client";

import { useRef, useState } from "react";
import { extractFirstUrl } from "@/lib/url";

/**
 * Paste box — the desktop path when the extension isn't installed, and the
 * fallback on any device where the share sheet isn't available.
 *
 * Pasting a recognisable link saves it immediately: on a phone the whole
 * interaction is copy, switch app, paste, and making someone reach for a
 * second button after that is pure friction. Typing still needs the button —
 * auto-saving on every keystroke would fire halfway through a URL.
 */
export function AddLink({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function save(raw: string) {
    const value = raw.trim();
    // A ref, not the `saving` state: two paste events in the same tick would
    // both read the pre-render state and fire twice.
    if (!value || inFlight.current) return;

    inFlight.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save that link");

      setUrl("");
      setMessage(data.alreadySaved ? "Already saved — moved to top" : "Saved");
      // Clear the confirmation on its own; there's no button press to ack it.
      setTimeout(() => setMessage(null), 2500);
      await onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save that link");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  /**
   * Read the link from the clipboard rather than from the input: the paste
   * event fires *before* the value updates, so the input is still empty here.
   */
  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    const link = extractFirstUrl(pasted);

    // Not a link — let the paste land so it can be corrected by hand.
    if (!link) return;

    e.preventDefault();
    setUrl(link);
    void save(link);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(url);
      }}
      className="px-3 py-3 sm:px-4"
    >
      <div className="flex gap-2">
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={onPaste}
          placeholder="Paste a link…"
          aria-label="Paste a link to save it"
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
        <p
          className="mt-2 text-[13px]"
          style={{ color: "var(--text-muted)" }}
          role="status"
        >
          {message}
        </p>
      )}
    </form>
  );
}
