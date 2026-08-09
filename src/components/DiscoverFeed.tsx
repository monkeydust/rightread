"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { hostLabel } from "@/lib/url";
import type { DiscoverPayload, DiscoverHit, NearMiss } from "@/lib/recommendations";

/**
 * Optimistic removal. Saving or dismissing should feel instant — the row is
 * gone from the list before the request finishes, and only comes back if it
 * failed. Waiting for a round trip to remove something you have already
 * decided about reads as lag.
 */
function useResolved() {
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const mark = (id: string) => setResolved((s) => new Set(s).add(id));
  const unmark = (id: string) =>
    setResolved((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  return { resolved, mark, unmark };
}

function Hit({
  hit,
  hide,
  restore,
}: {
  hit: DiscoverHit;
  hide: (id: string) => void;
  restore: (id: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"save" | "dismiss" | null>(null);
  const [error, setError] = useState(false);

  async function act(kind: "save" | "dismiss") {
    setBusy(kind);
    setError(false);
    hide(hit.candidateId);
    try {
      const res = await fetch(`/api/candidates/${hit.candidateId}/${kind}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      // Put it back. A row that vanished on a failed request would read as
      // success, which is the worst outcome: the user believes it is saved.
      restore(hit.candidateId);
      setError(true);
      setBusy(null);
    }
  }

  return (
    <li className="border-b py-3" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-baseline gap-2">
        <a
          href={hit.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 text-[15px] font-medium leading-snug hover:underline"
          style={{ color: "var(--text)" }}
        >
          {hit.title}
        </a>
        <span
          className="shrink-0 text-[11px] tabular-nums"
          style={{ color: "var(--text-muted)" }}
          title="How closely this matches"
        >
          {Math.round(hit.score * 100)}%
        </span>
      </div>

      {hit.excerpt && (
        <p
          className="mt-1 line-clamp-2 text-[13px] leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {hit.excerpt}
        </p>
      )}

      <div
        className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[12px]"
        style={{ color: "var(--text-muted)" }}
      >
        <span>{hit.sourceTitle || hostLabel(hit.url)}</span>
        {hit.wordCount ? (
          <>
            <span aria-hidden>·</span>
            <span>{hit.wordCount.toLocaleString()} words</span>
          </>
        ) : null}
        <span aria-hidden>·</span>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void act("save")}
          className="font-medium hover:underline disabled:opacity-40"
          style={{ color: "var(--accent)" }}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void act("dismiss")}
          className="hover:underline disabled:opacity-40"
        >
          Not interested
        </button>
        {error && <span className="text-red-600">didn&rsquo;t work — try again</span>}
      </div>
    </li>
  );
}

/**
 * What a phrase nearly matched.
 *
 * Without this, "nothing matched" and "something is broken" look identical,
 * and there is no way to tell whether the bar is set where you want it. The
 * scores are shown because the number is the whole point: 26% against a 32%
 * bar is a system working, not a system failing.
 */
function NearMisses({ misses }: { misses: NearMiss[] }) {
  const withAny = misses.filter((m) => m.closest.length > 0);
  if (withAny.length === 0) return null;

  return (
    <div className="mt-8">
      {withAny.map((m) => (
        <section key={m.phrase} className="mt-5 first:mt-0">
          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            Nothing matched <strong style={{ color: "var(--text)" }}>{m.phrase}</strong>{" "}
            — the bar is {Math.round(m.floor * 100)}%. Closest so far:
          </p>
          <ul className="mt-1.5">
            {m.closest.map((c) => (
              <li key={c.url} className="flex items-baseline gap-2 py-0.5">
                <span
                  className="w-9 shrink-0 text-right text-[12px] tabular-nums"
                  style={{ color: "var(--text-muted)" }}
                >
                  {Math.round(c.score * 100)}%
                </span>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 text-[13px] hover:underline"
                  style={{ color: "var(--text-muted)" }}
                >
                  {c.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="mt-4 text-[12px]" style={{ color: "var(--text-muted)" }}>
        Sources are checked every 15 minutes and the pool grows over time, so a
        phrase can sit quiet for a while and then start matching. More listeners
        widen the net.
      </p>
    </div>
  );
}

export function DiscoverFeed({ data }: { data: DiscoverPayload }) {
  const { resolved, mark, unmark } = useResolved();

  const groups = data.groups
    .map((g) => ({ ...g, hits: g.hits.filter((h) => !resolved.has(h.candidateId)) }))
    .filter((g) => g.hits.length > 0);

  // Three genuinely different empty states. Collapsing them into one "nothing
  // here" would leave the user unable to tell a misconfiguration from a quiet
  // week.
  if (groups.length === 0) {
    return (
      <div className="px-4 py-16 text-center">
        {!data.hasSources ? (
          <>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No sources yet.
            </p>
            <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Add a site to watch in{" "}
              <a href="/settings" className="underline">
                Settings
              </a>{" "}
              — Hacker News, Lobsters, a blog you follow.
            </p>
          </>
        ) : !data.hasPhrases ? (
          <>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No key phrases yet.
            </p>
            <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Add a topic in{" "}
              <a href="/settings" className="underline">
                Settings
              </a>{" "}
              and anything matching it will collect here.
            </p>
          </>
        ) : (
          <div className="mx-auto max-w-xl text-left">
            <p className="text-center text-sm" style={{ color: "var(--text-muted)" }}>
              Nothing has matched yet — which is an answer, not a fault.
            </p>
            <NearMisses misses={data.nearMisses} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="px-3 pb-16 sm:px-4">
      {groups.map((group) => (
        <section key={group.key} className="mt-6 first:mt-3">
          <div
            className="flex items-baseline justify-between border-b pb-1.5"
            style={{ borderColor: "var(--border)" }}
          >
            <h2 className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>
              {group.kind === "phrase" ? (
                group.label
              ) : (
                <>
                  <span className="font-normal" style={{ color: "var(--text-muted)" }}>
                    because you saved{" "}
                  </span>
                  {group.label}
                </>
              )}
            </h2>
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {group.hits.length}
            </span>
          </div>
          <ul>
            {group.hits.map((hit) => (
              <Hit
                key={hit.recommendationId}
                hit={hit}
                hide={mark}
                restore={unmark}
              />
            ))}
          </ul>
        </section>
      ))}

      <NearMisses misses={data.nearMisses} />
    </div>
  );
}
