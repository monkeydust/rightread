import { prisma } from "@/lib/db";
import { fromBlob, cosine } from "@/lib/search/embed";

export type Recommendation = {
  id: string;
  url: string;
  title: string;
  siteName: string | null;
  excerpt: string | null;
  publishedAt: Date | null;
  wordCount: number | null;
  /** 0-1 cosine similarity to the item being read. */
  score: number;
  sourceTitle: string | null;
};

export type SimilarResult = {
  hits: Recommendation[];
  /**
   * Why the list is empty, when it is empty for a reason. "no-candidates"
   * covers both "no sources yet" and "nothing embedded yet" — the settings
   * page is the fix for either.
   */
  status: "ok" | "not-embedded" | "no-candidates";
};

const LIMIT = 5;

/**
 * Similarity floor for recommendations — deliberately NOT the search floor.
 *
 * Search's 0.22 (search/embed.ts) was measured for short query → article
 * pairs. Article → article scores run systematically hotter: two long texts
 * share far more general vocabulary, so even unrelated articles clear 0.22
 * easily. Measured on text-embedding-3-small:
 *
 *   finance article vs unrelated tech-blog posts          0.24–0.34
 *   finance HN thread vs unrelated HN-frontpage articles  up to 0.41
 *   retro-computing article vs devtools/newsletter        0.41–0.44 (adjacent)
 *
 * 0.38 was the first attempt and shipped bad recommendations on day one: with
 * a topically-broad source (the HN frontpage), *unrelated* pairs reach 0.41 —
 * everything is long discussion-flavoured English. 0.38–0.44 is an ambiguous
 * zone where related and unrelated overlap, so the floor sits above it.
 * Precision over recall, deliberately: a wrong recommendation reads as a
 * broken feature, an absent panel reads as honesty. Genuinely same-topic
 * pairs score comfortably above 0.5. Tune via RIGHTREAD_REC_FLOOR;
 * re-measure from scratch on any model change.
 */
const DEFAULT_REC_FLOOR = 0.45;

/** Same defensive parsing as readFloor() in search/embed.ts, same reasons. */
function recFloor(): number {
  const raw = process.env.RIGHTREAD_REC_FLOOR?.trim();
  if (!raw) return DEFAULT_REC_FLOOR;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(
      `[sources] ignoring RIGHTREAD_REC_FLOOR=${JSON.stringify(raw)} ` +
        `(want a number 0-1); using ${DEFAULT_REC_FLOOR}`
    );
    return DEFAULT_REC_FLOOR;
  }
  return parsed;
}

const FLOOR = recFloor();

/**
 * Ranks the user's candidate pool against one item's embedding.
 *
 * The mirror image of semanticSearch() in search/search.ts: brute-force
 * cosine over every stored vector, floored, top N. Same deliberate naivety —
 * the pool is capped at ~200 per source, so even dozens of sources score in
 * milliseconds.
 */
export async function similarCandidates(
  userId: string,
  itemId: string
): Promise<SimilarResult> {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: { userId: true, embedding: true, url: true, resolvedUrl: true },
  });
  if (!item || item.userId !== userId) return { hits: [], status: "no-candidates" };
  if (!item.embedding) return { hits: [], status: "not-embedded" };

  const candidates = await prisma.candidate.findMany({
    // savedItemId set means it is already in the library.
    where: { userId, savedItemId: null, embedding: { not: null } },
    select: {
      id: true,
      url: true,
      resolvedUrl: true,
      title: true,
      siteName: true,
      excerpt: true,
      publishedAt: true,
      wordCount: true,
      embedding: true,
      source: { select: { title: true } },
    },
  });
  if (candidates.length === 0) return { hits: [], status: "no-candidates" };

  // A candidate can slip past the ingest-time dedupe if the user saved the
  // article *after* it was admitted — recheck against the library here, by
  // URL. Loading just the URLs is cheap relative to the vectors we already
  // loaded above.
  const libraryUrls = new Set<string>();
  const items = await prisma.item.findMany({
    where: { userId },
    select: { url: true, resolvedUrl: true },
  });
  for (const i of items) {
    libraryUrls.add(i.url);
    if (i.resolvedUrl) libraryUrls.add(i.resolvedUrl);
  }

  const queryVector = fromBlob(item.embedding);

  const hits = candidates
    .filter(
      (c) =>
        !libraryUrls.has(c.url) && !(c.resolvedUrl && libraryUrls.has(c.resolvedUrl))
    )
    .map((c) => ({
      id: c.id,
      url: c.url,
      title: c.title,
      siteName: c.siteName,
      excerpt: c.excerpt,
      publishedAt: c.publishedAt,
      wordCount: c.wordCount,
      sourceTitle: c.source.title,
      score: cosine(queryVector, fromBlob(c.embedding!)),
    }))
    .filter((c) => c.score >= FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);

  return { hits, status: "ok" };
}
