"use client";

import Link from "next/link";
import { hostLabel } from "@/lib/url";

export type SearchHit = {
  id: string;
  url: string;
  title: string;
  siteName: string | null;
  kind: string;
  status: string;
  savedAt: string;
  wordCount: number | null;
  snippet?: string | null;
  score?: number;
};

export type SearchPayload = {
  query: string;
  hasWildcard: boolean;
  exact: SearchHit[];
  semantic: SearchHit[];
  semanticStatus: "ok" | "unavailable" | "not-indexed" | "skipped";
  tookMs: number;
};

/**
 * Renders an FTS5 snippet.
 *
 * The server delimits matches with U+0001/U+0002 instead of returning HTML,
 * because the text comes from arbitrary web pages. Splitting on the sentinels
 * and emitting real elements means page content is never parsed as markup —
 * `dangerouslySetInnerHTML` here would be an injection vector for whatever a
 * saved page happened to contain.
 */
function Snippet({ text }: { text: string }) {
  // Built from char codes rather than written literally: U+0001/U+0002 are
  // invisible in an editor and get mangled by tooling that touches the file.
  const parts = text.split(
    new RegExp(`[${String.fromCharCode(1)}${String.fromCharCode(2)}]`)
  );
  return (
    <p
      className="mt-1 text-[13px] leading-relaxed"
      style={{ color: "var(--text-muted)" }}
    >
      {parts.map((part, i) =>
        // Odd indices sit between an opening and closing sentinel.
        i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded-[2px] px-0.5"
            style={{
              background: "color-mix(in srgb, var(--accent) 30%, transparent)",
              color: "var(--text)",
            }}
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

function Hit({ hit }: { hit: SearchHit }) {
  return (
    <li
      className="border-b px-3 py-3 sm:px-4"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-baseline gap-2">
        <Link
          href={`/read/${hit.id}`}
          className="min-w-0 flex-1 text-[15px] font-medium leading-snug hover:underline"
          style={{ color: "var(--text)" }}
        >
          {hit.title}
        </Link>
        {typeof hit.score === "number" && (
          <span
            className="shrink-0 text-[11px] tabular-nums"
            style={{ color: "var(--text-muted)" }}
            title="Similarity to your query"
          >
            {Math.round(hit.score * 100)}%
          </span>
        )}
      </div>

      {hit.snippet ? <Snippet text={hit.snippet} /> : null}

      <div
        className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[12px]"
        style={{ color: "var(--text-muted)" }}
      >
        <span>{hit.kind}</span>
        <span aria-hidden>·</span>
        <span>{hit.siteName || hostLabel(hit.url)}</span>
        {hit.status === "archived" && (
          <>
            <span aria-hidden>·</span>
            <span>archived</span>
          </>
        )}
      </div>
    </li>
  );
}

function SectionHeading({
  title,
  hint,
  count,
}: {
  title: string;
  hint: string;
  count: number;
}) {
  return (
    <div
      className="flex items-baseline justify-between border-b px-3 pb-1.5 pt-4 sm:px-4"
      style={{ borderColor: "var(--border)" }}
    >
      <h2 className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>
        {title}{" "}
        <span className="font-normal" style={{ color: "var(--text-muted)" }}>
          {count}
        </span>
      </h2>
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        {hint}
      </span>
    </div>
  );
}

export function SearchResults({
  results,
  loading,
}: {
  results: SearchPayload | null;
  loading: boolean;
}) {
  if (!results) {
    return loading ? (
      <p
        className="px-4 py-10 text-center text-sm"
        style={{ color: "var(--text-muted)" }}
      >
        Searching…
      </p>
    ) : null;
  }

  const { exact, semantic, semanticStatus } = results;
  const nothing = exact.length === 0 && semantic.length === 0;

  return (
    <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
      {nothing && (
        <p
          className="px-4 py-12 text-center text-sm"
          style={{ color: "var(--text-muted)" }}
        >
          Nothing matches <strong>{results.query}</strong> — by words or by meaning.
        </p>
      )}

      {exact.length > 0 && (
        <>
          <SectionHeading
            title="Exact matches"
            hint={
              results.hasWildcard
                ? "these words appear (wildcard)"
                : "these words appear on the page"
            }
            count={exact.length}
          />
          <ul>
            {exact.map((h) => (
              <Hit key={h.id} hit={h} />
            ))}
          </ul>
        </>
      )}

      {semantic.length > 0 && (
        <>
          <SectionHeading
            title="Related by meaning"
            hint="similar topic, different words"
            count={semantic.length}
          />
          <ul>
            {semantic.map((h) => (
              <Hit key={h.id} hit={h} />
            ))}
          </ul>
        </>
      )}

      {/* Explain an empty semantic section rather than leaving it silent. */}
      {!nothing && semantic.length === 0 && semanticStatus !== "ok" && (
        <p
          className="px-4 py-3 text-[12px]"
          style={{ color: "var(--text-muted)" }}
        >
          {semanticStatus === "unavailable"
            ? "Related-by-meaning search is unavailable right now."
            : "Nothing indexed for meaning-based search yet."}
        </p>
      )}
    </div>
  );
}
