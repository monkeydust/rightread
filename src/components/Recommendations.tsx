import { similarCandidates } from "@/lib/sources/similar";
import { readingMinutes } from "@/lib/extract";
import { hostLabel } from "@/lib/url";
import { SaveRecommendation } from "./SaveRecommendation";

/**
 * "More like this from your sources" — rendered server-side at the end of the
 * reader. The item's stored vector is the query, so this is one DB read and
 * some arithmetic; no network call happens at read time.
 *
 * Renders nothing when nothing clears the similarity floor. An empty panel
 * with filler ("no recommendations yet!") would train the eye to skip the
 * space; absence is the honest signal.
 */
export async function Recommendations({
  userId,
  itemId,
}: {
  userId: string;
  itemId: string;
}) {
  const { hits, status } = await similarCandidates(userId, itemId);
  if (status !== "ok" || hits.length === 0) return null;

  return (
    <section className="no-print mt-12">
      <hr
        style={{
          border: 0,
          borderTop:
            "1px solid color-mix(in srgb, var(--paper-text) 12%, transparent)",
        }}
      />
      <div className="mt-6 flex items-baseline justify-between">
        <h2
          className="text-[15px] font-semibold"
          style={{ color: "var(--paper-text)" }}
        >
          More like this from your sources
        </h2>
        <span
          className="text-[11px]"
          style={{ color: "color-mix(in srgb, var(--paper-text) 55%, transparent)" }}
        >
          similar topic
        </span>
      </div>

      <ul className="mt-2">
        {hits.map((hit) => (
          <li
            key={hit.id}
            className="flex items-start gap-3 border-b py-3"
            style={{
              borderColor:
                "color-mix(in srgb, var(--paper-text) 10%, transparent)",
            }}
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
                  style={{
                    color:
                      "color-mix(in srgb, var(--paper-text) 55%, transparent)",
                  }}
                  title="Similarity to this article"
                >
                  {Math.round(hit.score * 100)}%
                </span>
              </div>

              {hit.excerpt && (
                <p
                  className="mt-1 line-clamp-2 text-[13px] leading-relaxed"
                  style={{
                    color:
                      "color-mix(in srgb, var(--paper-text) 65%, transparent)",
                  }}
                >
                  {hit.excerpt}
                </p>
              )}

              <div
                className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px]"
                style={{
                  color: "color-mix(in srgb, var(--paper-text) 55%, transparent)",
                }}
              >
                <span>{hit.sourceTitle || hit.siteName || hostLabel(hit.url)}</span>
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
    </section>
  );
}
