"use client";

import { useEffect, useRef, useState } from "react";
import { buildCopyText } from "@/lib/article-text";

type State = "idle" | "copied" | "failed";

const LABELS: Record<State, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed",
};

/**
 * Copies the article — title first, then the body — to the clipboard.
 *
 * The text is read from the rendered `.prose-reader` rather than fetched or
 * passed as a prop: that element is already on the page, it is what the reader
 * can actually see, and `innerText` preserves the paragraph breaks that the
 * stored `textContent` no longer has (see src/lib/article-text.ts). The
 * recommendations panel sits outside `.prose-reader`, so it is never copied.
 *
 * Rendered on every article unconditionally, including ones saved before this
 * existed — nothing here reads a stored field, so there is no backfill and no
 * such thing as an item too old to copy. On a page whose extraction is still
 * pending or has failed there is no `.prose-reader` at all, and the copy is
 * the title on its own rather than an error.
 */
export function CopyArticle({ title }: { title: string }) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function flash(next: State) {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  async function copy() {
    const body =
      document.querySelector<HTMLElement>(".prose-reader")?.innerText ?? "";
    const text = buildCopyText(title, body);
    flash((await writeClipboard(text)) ? "copied" : "failed");
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Copy the article text"
      className="rounded-md px-2 py-1.5 text-[13px] font-medium hover:bg-[var(--bg-subtle)]"
      style={{ color: "var(--text-muted)" }}
    >
      {/* The label is the only confirmation, so it has to be announced too. */}
      <span aria-live="polite">{LABELS[state]}</span>
    </button>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  // `navigator.clipboard` is undefined on an insecure origin, which is exactly
  // how rightread gets used over a LAN (the README calls this out for the PWA
  // features). So the legacy path below is not belt-and-braces — over plain
  // HTTP it is the only path there is.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or the document was not focused. Fall through.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  // Fixed and off-screen: `position: absolute` would extend the scrollable
  // area, and anything `display: none` cannot be selected at all.
  ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
  document.body.appendChild(ta);

  const selection = document.getSelection();
  const previous =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();

  // Selecting the textarea blew away whatever the reader had highlighted.
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}
