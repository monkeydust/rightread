import Link from "next/link";
import { articleEndings, type EndingSlot } from "@/lib/sources/endings";
import { readingMinutes } from "@/lib/extract";
import { hostLabel } from "@/lib/url";
import { SaveRecommendation } from "./SaveRecommendation";

/**
 * The end of an article: graded distance, honestly labelled.
 *
 * "More like this" alone is convergent — it narrows. This adds a step away, a
 * leap, and one thing from the reader's own unread queue, because the adjacent
 * and the tangential are where incidental discovery happens. Every group that
 * has nothing renders nothing: absence is the honest signal, and a padded slot
 * would be a claim the geometry doesn't support.
 *
 * Server component, mounted behind Suspense — the article must paint first.
 */

const MUTED = "color-mix(in srgb, var(--paper-text) 55%, transparent)";
const SOFT = "color-mix(in srgb, var(--paper-text) 65%, transparent)";
const RULE = "color-mix(in srgb, var(--paper-text) 12%, transparent)";
const ROW_RULE = "color-mix(in srgb, var(--paper-text) 10%, transparent)";

function savedLabel(savedAt: Date | null): string | null {
  if (!savedAt) return null;
  const d = new Date(savedAt);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function SlotRow({
  slot,
  label,
  hint,
}: {
  slot: EndingSlot;
  label: string;
  hint: string;
}) {
  const inner = (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span
          className="min-w-0 flex-1 text-[14px] font-medium leading-snug"
          style={{ color: "var(--paper-text)" }}
        >
          {slot.title}
        </span>
        <span
          className="shrink-0 text-[11px]"
          style={{ color: MUTED }}
          title={hint}
        >
          {label}
        </span>
      </div>
      {slot.excerpt && (
        <p
          className="mt-1 line-clamp-2 text-[13px] leading-relaxed"
          style={{ color: SOFT }}
        >
          {slot.excerpt}
        </p>
      )}
      <div
        className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px]"
        style={{ color: MUTED }}
      >
        <span>{slot.siteName || hostLabel(slot.url)}</span>
        {slot.wordCount ? (
          <>
            <span aria-hidden>·</span>
            <span>{readingMinutes(slot.wordCount)} min read</span>
          </>
        ) : null}
        {slot.band === "backlog" && savedLabel(slot.savedAt) ? (
          <>
            <span aria-hidden>·</span>
            <span>you saved this {savedLabel(slot.savedAt)}</span>
          </>
        ) : null}
      </div>
    </div>
  );

  return (
    <li
      className="flex items-start gap-3 border-b py-3"
      style={{ borderColor: ROW_RULE }}
    >
      {slot.origin === "library" ? (
        <Link href={`/read/${slot.id}`} className="min-w-0 flex-1 hover:underline">
          {inner}
        </Link>
      ) : (
        <>
          <a
            href={slot.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 hover:underline"
          >
            {inner}
          </a>
          <SaveRecommendation candidateId={slot.id} />
        </>
      )}
    </li>
  );
}

export async function ArticleEndings({
  userId,
  itemId,
}: {
  userId: string;
  itemId: string;
}) {
  const endings = await articleEndings(userId, itemId);
  const { closest, step, leap, backlog, trailReady } = endings;

  const hasAnything =
    closest.length > 0 || step !== null || leap !== null || backlog !== null;
  if (!hasAnything) return null;

  return (
    <section className="no-print mt-12">
      <hr style={{ border: 0, borderTop: `1px solid ${RULE}` }} />

      {closest.length > 0 && (
        <>
          <div className="mt-6 flex items-baseline justify-between">
            <h2
              className="text-[15px] font-semibold"
              style={{ color: "var(--paper-text)" }}
            >
              More like this from your sources
            </h2>
            <span className="text-[11px]" style={{ color: MUTED }}>
              closest
            </span>
          </div>
          <ul className="mt-2">
            {closest.map((hit) => (
              <li
                key={hit.id}
                className="flex items-start gap-3 border-b py-3"
                style={{ borderColor: ROW_RULE }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <a
                      href={hit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 text-[14px] font-medium leading-snug hover:underline"
                      style={{ color: "var(--paper-text)" }}
                    >
                      {hit.title}
                    </a>
                    <span
                      className="shrink-0 text-[11px] tabular-nums"
                      style={{ color: MUTED }}
                      title="Similarity to this article"
                    >
                      {Math.round(hit.score * 100)}%
                    </span>
                  </div>
                  {hit.excerpt && (
                    <p
                      className="mt-1 line-clamp-2 text-[13px] leading-relaxed"
                      style={{ color: SOFT }}
                    >
                      {hit.excerpt}
                    </p>
                  )}
                  <div
                    className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px]"
                    style={{ color: MUTED }}
                  >
                    <span>
                      {hit.sourceTitle || hit.siteName || hostLabel(hit.url)}
                    </span>
                    {hit.wordCount ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>{readingMinutes(hit.wordCount)} min read</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <SaveRecommendation candidateId={hit.id} />
              </li>
            ))}
          </ul>
        </>
      )}

      {(step || leap || backlog) && (
        <>
          <div className="mt-6 flex items-baseline justify-between">
            <h2
              className="text-[15px] font-semibold"
              style={{ color: "var(--paper-text)" }}
            >
              Further afield
            </h2>
            <span className="text-[11px]" style={{ color: MUTED }}>
              from your own library
            </span>
          </div>
          <ul className="mt-2">
            {backlog && (
              <SlotRow
                slot={backlog}
                label="in your queue"
                hint="Unread, and next door to what you just finished"
              />
            )}
            {step && (
              <SlotRow
                slot={step}
                label={step.origin === "candidate" ? "a step away · from your sources" : "a step away"}
                hint="Closer than 90% of pairs in your library, but not the closest"
              />
            )}
            {leap && (
              <SlotRow
                slot={leap}
                label="a leap"
                hint="A weak but real connection — a different direction"
              />
            )}
          </ul>
        </>
      )}

      {trailReady && (
        <p className="mt-5 text-[13px]">
          <Link
            href={`/trail/${itemId}`}
            className="hover:underline"
            style={{ color: "var(--paper-text)" }}
          >
            Start a trail from here →
          </Link>
          <span className="ml-2" style={{ color: MUTED }}>
            a five-stop walk through your library
          </span>
        </p>
      )}
    </section>
  );
}
