"use client";

import { useState, useSyncExternalStore } from "react";
import { isOnline, netFetch, subscribeConnectivity, isNetworkError } from "@/lib/connectivity";
import { invalidateArticleCache } from "@/lib/sw-invalidate";
import { Working } from "@/components/Working";
import type { StoredSummary } from "@/lib/summarize/store";

/**
 * A thread's summary history, newest on top, with the button that adds to it.
 *
 * Nothing here is automatic. The panel starts as one line and a button; a
 * summary exists only because the reader asked for one, and a second one only
 * because they asked again. What is shown first on a refresh is "since last
 * time" — the delta is what they came back for — and the earlier summaries
 * stay underneath, because the sequence is the record of how the discussion
 * moved.
 *
 * Client component because the button needs state and connectivity; the
 * history itself is server-rendered into the page, so it reads offline.
 */

const MUTED = "color-mix(in srgb, var(--paper-text) 55%, transparent)";
const SOFT = "color-mix(in srgb, var(--paper-text) 72%, transparent)";
const RULE = "color-mix(in srgb, var(--paper-text) 12%, transparent)";
const TINT = "color-mix(in srgb, var(--accent) 9%, transparent)";

/** A summary can take most of a minute on a big thread; give it room. */
const SUMMARY_TIMEOUT_MS = 120_000;

type Serialised = Omit<StoredSummary, "createdAt" | "fetchedAt"> & {
  createdAt: string;
  fetchedAt: string;
};

export function ThreadSummary({
  itemId,
  summaries,
  commentCount,
}: {
  itemId: string;
  /** Newest first. Dates as ISO strings — this crosses the RSC boundary. */
  summaries: Serialised[];
  /** From the stored thread, when known; shown before any summary exists. */
  commentCount: number | null;
}) {
  const online = useSyncExternalStore(subscribeConnectivity, isOnline, () => true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = summaries[0];
  const earlier = summaries.slice(1);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await netFetch(
        `/api/items/${itemId}/summary`,
        { method: "POST" },
        SUMMARY_TIMEOUT_MS
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Couldn't summarise (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      // A full reload, not router.refresh(). The article is cache-first in the
      // service worker, so a refresh was answered with the page as it was —
      // and with a payload cached from a navigation, which the router could
      // not reconcile with a refresh and wedged on. Forget the cached article
      // first so the reload reaches the server, and let the browser start a
      // clean router from the new document. Stays busy until the new page
      // paints; there is nothing to hand back to.
      await invalidateArticleCache(window.location.pathname);
      window.location.reload();
    } catch (err) {
      setError(
        isNetworkError(err)
          ? "No connection — summaries need the network."
          : "Couldn't summarise this thread."
      );
      setBusy(false);
    }
  }

  const button = (
    <button
      type="button"
      onClick={generate}
      disabled={busy || !online}
      title={!online ? "Summaries need a connection" : undefined}
      // Busy is not disabled-looking: the indicator is the state, so the
      // button keeps its full colour while it works and only fades offline.
      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-default ${
        busy ? "" : "disabled:opacity-50"
      }`}
      style={
        latest
          ? { color: "var(--paper-text)", border: `1px solid ${RULE}` }
          : { background: "var(--accent)", color: "var(--accent-ink)" }
      }
    >
      {busy && <Working />}
      {busy
        ? latest
          ? "Re-reading the thread…"
          : "Reading the thread…"
        : latest
          ? "Refresh"
          : "Summarise this thread"}
    </button>
  );

  return (
    <section className="no-print mt-6" aria-label="Thread summary">
      {!latest ? (
        <div className="flex flex-wrap items-center gap-3">
          {button}
          <span className="text-[13px]" style={{ color: MUTED }}>
            {commentCount != null
              ? `${commentCount} comment${commentCount === 1 ? "" : "s"} · where it stands, who disagrees, what's worth reading`
              : "where it stands, who disagrees, what's worth reading"}
            {!online && " · offline"}
          </span>
        </div>
      ) : (
        <div
          className="rounded-lg px-4 py-4"
          style={{ border: `1px solid ${RULE}` }}
        >
          <SummaryBody summary={latest} />

          <div
            className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[12px]"
            style={{ color: MUTED }}
          >
            <span>{stamp(latest)}</span>
            {button}
          </div>

          {earlier.length > 0 && (
            <details className="mt-3">
              <summary
                className="cursor-pointer text-[12px] select-none"
                style={{ color: MUTED }}
              >
                Earlier summar{earlier.length === 1 ? "y" : "ies"} ({earlier.length})
              </summary>
              <ol className="mt-2">
                {earlier.map((s) => (
                  <li
                    key={s.id}
                    className="border-t py-3"
                    style={{ borderColor: RULE }}
                  >
                    <div className="text-[12px]" style={{ color: MUTED }}>
                      {stamp(s)}
                    </div>
                    <SummaryBody summary={s} compact />
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 text-[13px]" style={{ color: "var(--accent)" }} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SummaryBody({ summary, compact = false }: { summary: Serialised; compact?: boolean }) {
  return (
    <div className={compact ? "mt-1" : ""}>
      {summary.sinceLast && (
        <div
          className="-mx-2 mb-3 rounded-md px-2 py-2"
          style={{ background: TINT }}
        >
          <div
            className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--accent)" }}
          >
            Since last time
          </div>
          <p
            className="mt-1 text-[14px] leading-relaxed"
            style={{ color: "var(--paper-text)" }}
          >
            {summary.sinceLast}
          </p>
        </div>
      )}

      <p
        className={compact ? "text-[13px] leading-relaxed" : "text-[15px] leading-relaxed"}
        style={{ color: "var(--paper-text)" }}
      >
        {summary.tldr}
      </p>

      {!compact && summary.points.length > 0 && (
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed" style={{ color: SOFT }}>
          {summary.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}

      {!compact && summary.standout.length > 0 && (
        <>
          <div className="mt-4 text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
            Worth reading
          </div>
          <ul className="mt-1 space-y-1 text-[14px] leading-relaxed" style={{ color: SOFT }}>
            {summary.standout.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {!compact && summary.links.length > 0 && (
        <>
          <div className="mt-4 text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
            Mentioned
          </div>
          <ul className="mt-1 space-y-1 text-[13px] leading-relaxed" style={{ color: SOFT }}>
            {summary.links.map((l, i) => (
              <li key={i} className="break-words">
                <LinkLine line={l} />
              </li>
            ))}
          </ul>
        </>
      )}

      {!compact && summary.verdict && (
        <p className="mt-4 text-[13px] italic leading-relaxed" style={{ color: MUTED }}>
          {summary.verdict}
        </p>
      )}
    </div>
  );
}

/**
 * "<url> — <what it is>" from the model, with only http(s) URLs made
 * clickable. The model's text is untrusted; a non-URL first token renders as
 * plain text and nothing else is interpreted.
 */
function LinkLine({ line }: { line: string }) {
  const m = line.match(/^(https?:\/\/\S+)\s*(?:[—–-]\s*)?(.*)$/);
  if (!m) return <>{line}</>;
  const [, url, rest] = m;
  return (
    <>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:no-underline"
        style={{ color: "var(--paper-text)" }}
      >
        {shortUrl(url)}
      </a>
      {rest && <span> — {rest}</span>}
    </>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    const s = u.hostname.replace(/^www\./, "") + path;
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  } catch {
    return url;
  }
}

function stamp(s: Serialised): string {
  const when = new Date(s.createdAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
  const parts = [`Summarised ${when}`];
  if (s.commentCount != null) {
    parts.push(
      `${s.commentCount} comment${s.commentCount === 1 ? "" : "s"}` +
        (s.newComments != null && s.newComments > 0 ? ` (+${s.newComments} new)` : "")
    );
  }
  return parts.join(" · ");
}
