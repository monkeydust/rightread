"use client";

import { KINDS } from "@/lib/classify/kinds";
import { kindColour } from "@/components/SemanticGraph";

type Stats = {
  moderateAt: number;
  strongAt: number;
  unlinked: number;
  truncated: number;
  pairsScored: number;
  tookMs: number;
};

export function GraphLegend({
  k,
  onK,
  hidden,
  onToggleKind,
  includeArchived,
  onIncludeArchived,
  stats,
  nodeCount,
  edgeCount,
  loading,
}: {
  k: number;
  onK: (k: number) => void;
  hidden: Set<string>;
  onToggleKind: (kind: string) => void;
  includeArchived: boolean;
  onIncludeArchived: (v: boolean) => void;
  stats: Stats | null;
  nodeCount: number;
  edgeCount: number;
  loading: boolean;
}) {
  return (
    <div className="space-y-3" style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
      <div className="flex flex-wrap items-center gap-2">
        {KINDS.map((kind) => {
          const off = hidden.has(kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onToggleKind(kind)}
              aria-pressed={!off}
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors"
              style={{
                borderColor: off ? "var(--border)" : kindColour(kind),
                color: off ? "var(--text-muted)" : "var(--text)",
                opacity: off ? 0.5 : 1,
              }}
            >
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-full"
                style={{ background: kindColour(kind) }}
              />
              {kind}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
        <label className="flex items-center gap-2">
          <span>Links per page</span>
          <input
            type="range"
            min={2}
            max={8}
            value={k}
            onChange={(e) => onK(Number(e.target.value))}
            className="w-24 accent-[var(--accent)]"
          />
          <span className="tabular-nums" style={{ color: "var(--text)" }}>{k}</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => onIncludeArchived(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <span>Include archived</span>
        </label>

        <span>
          {nodeCount} pages · {edgeCount} connections
        </span>
      </div>

      {/*
        The bands are stated in percentile terms because the raw cosine number
        is misleading on its own. Measured across 21,321 real pairs, two
        completely unrelated articles still score about 0.24 — they share the
        "long English prose" direction. So 0.43 is not "close", it is merely
        the 90th percentile. Calibrating against the user's own library is
        what makes "strong" mean something, and saying so here is what stops
        the picture implying more than the data supports.
      */}
      {stats && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden>
              <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="2.2" strokeOpacity="0.75" />
            </svg>
            strong — closer than 99% of pairs here ({stats.strongAt.toFixed(2)}+)
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden>
              <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="1.3" strokeOpacity="0.4" />
            </svg>
            moderate — top 10% ({stats.moderateAt.toFixed(2)}+)
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden>
              <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="0.7" strokeOpacity="0.18" />
            </svg>
            weak — may be nothing but shared prose
          </span>
          <span>circle size = length · ring = starred · dashed = duplicate</span>
        </div>
      )}

      {stats && (stats.unlinked > 0 || stats.truncated > 0) && (
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          {stats.unlinked > 0 && (
            <>
              {stats.unlinked} page{stats.unlinked === 1 ? "" : "s"} not indexed for meaning
              (shown hollow) — run <code>npm run search:backfill</code> to link{" "}
              {stats.unlinked === 1 ? "it" : "them"}.
            </>
          )}
          {stats.truncated > 0 && (
            <> {stats.truncated} older page{stats.truncated === 1 ? "" : "s"} omitted by the size cap.</>
          )}
        </p>
      )}
    </div>
  );
}
