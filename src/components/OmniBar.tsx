"use client";

import { useEffect, useRef, useState } from "react";
import { classifyInput, extractFirstUrl } from "@/lib/url";
import { netFetch, isNetworkError } from "@/lib/connectivity";
import { enqueue } from "@/lib/outbox";
import { Star } from "@/components/icons";

/**
 * One box, two jobs: save a link, or search the library.
 *
 * Having a "paste a link" field directly above a "search" field asked the user
 * to classify their own intent before typing, when the input itself already
 * says which it is. A link is unambiguous — `extractFirstUrl` only accepts a
 * bare hostname when the whole value is a single token, so "rust async" can
 * never be mistaken for one.
 *
 * The two triggers are deliberately different, because the intents are:
 *
 *   Paste  -> if the clipboard holds a link, save it immediately. This is the
 *             behaviour the old paste box had and the reason it existed: on a
 *             phone the interaction is already copy, switch app, paste, and a
 *             confirming button press after that is pure friction.
 *   Typing -> never auto-saves. Typing a URL passes through many prefixes that
 *             are themselves valid ("example.c"), so a keystroke-triggered save
 *             would fire halfway through. Typing a link offers a Save button;
 *             typing anything else searches as you go.
 */
export function OmniBar({
  onSaved,
  onSearchTermChange,
  autoFocus = false,
  starredCount = 0,
  starredOnly = false,
  onToggleStarred,
}: {
  onSaved: () => Promise<void> | void;
  onSearchTermChange: (term: string) => void;
  autoFocus?: boolean;
  /** Starred items in the current list. The toggle is hidden when there are none. */
  starredCount?: number;
  starredOnly?: boolean;
  onToggleStarred?: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** Set when the user asks to search a value that looks like a link. */
  const [searchAnyway, setSearchAnyway] = useState(false);
  const inFlight = useRef(false);

  const intent = classifyInput(value);
  const link = intent.kind === "link" ? intent.url : null;
  const isLink = link !== null && !searchAnyway;
  // In link mode there is nothing to search for; "search for it instead"
  // flips that without the user having to retype.
  const searchTerm =
    intent.kind === "empty" ? "" : isLink ? "" : value.trim();

  // Report upward so the list owns the results; this component owns the input.
  useEffect(() => {
    onSearchTermChange(searchTerm);
  }, [searchTerm, onSearchTermChange]);

  async function save(raw: string) {
    const target = raw.trim();
    // A ref, not the `saving` state: two paste events in the same tick would
    // both read the pre-render state and fire twice.
    if (!target || inFlight.current) return;

    inFlight.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const res = await netFetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save that link");

      setValue("");
      setSearchAnyway(false);
      setMessage(data.alreadySaved ? "Already saved — moved to top" : "Saved");
      // Clear the confirmation on its own; there's no button press to ack it.
      setTimeout(() => setMessage(null), 2500);
      await onSaved();
    } catch (err) {
      /*
       * Offline, keep the link rather than losing it.
       *
       * The article itself cannot be fetched without a network — extraction is
       * a server-side fetch of the page — but the URL is the part that is hard
       * to get back. A capture box that refuses a link is a capture box that
       * loses a thought, which is the one thing it exists not to do; the item
       * appears, already extracting, when the connection returns.
       */
      if (isNetworkError(err)) {
        await enqueue({ kind: "capture", url: target });
        setValue("");
        setSearchAnyway(false);
        setMessage("Saved here — it'll be fetched when you're back online");
        setTimeout(() => setMessage(null), 3500);
      } else {
        setMessage(err instanceof Error ? err.message : "Could not save that link");
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  /**
   * Read from the clipboard rather than the input: the paste event fires
   * *before* the value updates, so the input is still empty here.
   *
   * This uses the looser test on purpose — a link anywhere in the pasted text
   * counts. Android's share and copy actions routinely hand over "Some Title
   * https://…", and refusing that would break the path this box exists for.
   */
  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    const found = extractFirstUrl(pasted);

    // An explicit scheme anywhere in the paste is taken at face value; a bare
    // token has to survive the same strict test typing does. Otherwise pasting
    // a one-word search would save "https://rust" — harmless-looking, and the
    // sort of thing that quietly fills a library with junk.
    const trusted =
      found !== null &&
      (/https?:\/\//i.test(pasted) || classifyInput(pasted).kind === "link");

    // Not a link — let it land as a search.
    if (!trusted || !found) return;

    e.preventDefault();
    setSearchAnyway(false);
    setValue(found);
    void save(found);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (isLink && link) void save(link);
      }}
      className="px-3 py-3 sm:px-4"
    >
      <div className="flex gap-2">
        <input
          type="text"
          autoFocus={autoFocus}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint={isLink ? "go" : "search"}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            // A fresh edit re-arms link detection.
            if (searchAnyway) setSearchAnyway(false);
          }}
          onPaste={onPaste}
          placeholder="Search, or paste a link to save"
          aria-label="Search your library, or paste a link to save it"
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
          style={{
            // The border is the mode indicator: it turns accent-coloured the
            // moment the box is holding a link, so the change of behaviour is
            // visible before the user commits to it.
            borderColor: isLink ? "var(--accent)" : "var(--border)",
            transition: "border-color 120ms",
          }}
        />
        {/* The starred filter lives in this row rather than on one of its own:
            it is a control that is usually off, and a whole strip of chrome
            above the list costs a row of articles on every screen to say so.
            Hidden in link mode — Save takes that space, and filtering the list
            is not what you are doing mid-paste. */}
        {!isLink && starredCount > 0 && onToggleStarred && (
          <button
            type="button"
            onClick={onToggleStarred}
            aria-pressed={starredOnly}
            aria-label={
              starredOnly
                ? `Showing ${starredCount} starred. Show everything`
                : `Show only ${starredCount} starred`
            }
            title={starredOnly ? "Show everything" : "Show only starred"}
            className="flex shrink-0 items-center gap-1 rounded-lg border px-2.5 text-sm transition-colors"
            style={{
              borderColor: starredOnly ? "var(--accent)" : "var(--border)",
              color: starredOnly ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            <Star size={15} filled={starredOnly} />
            <span className="tabular-nums">{starredCount}</span>
          </button>
        )}
        {isLink && (
          <button
            type="submit"
            disabled={saving}
            className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {isLink && !saving && (
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
          That looks like a link — press Save to add it.{" "}
          <button
            type="button"
            onClick={() => setSearchAnyway(true)}
            className="underline hover:no-underline"
          >
            Search for it instead
          </button>
        </p>
      )}

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
