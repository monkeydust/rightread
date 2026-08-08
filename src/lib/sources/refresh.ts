import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/url";
import { extractArticle } from "@/lib/extract";
import { embed, embeddableText, toBlob, EMBED_MODEL } from "@/lib/search/embed";
import { fetchFeed } from "./feed";

/**
 * New candidates taken per source per poll — one full feed's worth (RSS
 * feeds typically carry 20-30 entries; HN's carries 30). Bounds the
 * fetch/extract work a single poll can create; extraction stays serial, so
 * this raises how much a sweep may do, not how hard it hits the box at once.
 */
const NEW_PER_POLL = 30;

/**
 * Pruning: unsaved candidates beyond this age or count are deleted on each
 * poll. Saved ones are never pruned — their Item is the record, but the
 * candidate row keeps them out of future recommendations. ~200 × ~6 KB vector
 * keeps even dozens of sources in tens of megabytes.
 */
const MAX_AGE_DAYS = 60;
const MAX_PER_SOURCE = 200;

/**
 * Overlap guard. The hourly timer and the manual refresh button can fire
 * together; running two polls at once doubles load for zero benefit. A plain
 * module flag suffices because the app is exactly one Node process — the same
 * assumption src/lib/events.ts documents for SSE.
 */
let refreshing = false;

/** Refreshes every active source of every user, serially. Never throws. */
export async function refreshAllSources(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const sources = await prisma.source.findMany({
      where: { active: true },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    for (const s of sources) {
      await refreshSource(s.id);
    }
  } catch (err) {
    console.warn(
      "[sources] refresh sweep failed:",
      err instanceof Error ? err.message : err
    );
  } finally {
    refreshing = false;
  }
}

/**
 * Polls one source: parse its feed, admit new candidates, extract + embed
 * them serially, prune. Fail-soft throughout — an unreachable feed or a page
 * that won't extract is recorded on the row, never thrown. Background
 * ingestion breaking the app would invert the feature's value.
 */
export async function refreshSource(sourceId: string): Promise<void> {
  const source = await prisma.source
    .findUnique({ where: { id: sourceId } })
    .catch(() => null);
  if (!source || !source.active) return;

  let feed;
  try {
    feed = await fetchFeed(source.feedUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sources] feed fetch failed for ${source.feedUrl}: ${message}`);
    await prisma.source
      .update({
        where: { id: source.id },
        data: { lastFetchedAt: new Date(), lastError: message.slice(0, 300) },
      })
      .catch(() => {});
    return;
  }

  // Fill in feed metadata once; the user only had to paste the feed URL.
  await prisma.source.update({
    where: { id: source.id },
    data: {
      title: source.title ?? feed.title,
      siteUrl: source.siteUrl ?? feed.siteUrl,
      lastFetchedAt: new Date(),
      lastError: null,
    },
  });

  const admitted = await admitNewCandidates(source.userId, source.id, feed.entries);

  // Serial on purpose: extraction is jsdom-heavy and the box is small. One
  // page at a time mirrors how capture's detached extraction behaves.
  for (const candidateId of admitted) {
    await processCandidate(candidateId);
  }

  await prune(source.id);
}

/**
 * Filters feed entries down to genuinely new ones and creates pending rows.
 * Returns the created ids, newest-published first.
 */
async function admitNewCandidates(
  userId: string,
  sourceId: string,
  entries: { url: string; title: string; excerpt: string | null; publishedAt: Date | null }[]
): Promise<string[]> {
  // Normalize like capture does, so the same article never exists under both
  // a tracking-parameter URL and a clean one.
  const normalized = entries.flatMap((e) => {
    try {
      return [{ ...e, url: normalizeUrl(e.url) }];
    } catch {
      return [];
    }
  });
  if (normalized.length === 0) return [];

  const urls = normalized.map((e) => e.url);
  const [existingCandidates, existingItems] = await Promise.all([
    prisma.candidate.findMany({
      where: { userId, url: { in: urls } },
      select: { url: true },
    }),
    // Already in the library — recommending it back would be noise.
    prisma.item.findMany({
      where: { userId, OR: [{ url: { in: urls } }, { resolvedUrl: { in: urls } }] },
      select: { url: true, resolvedUrl: true },
    }),
  ]);

  const known = new Set<string>([
    ...existingCandidates.map((c) => c.url),
    ...existingItems.map((i) => i.url),
    ...existingItems.flatMap((i) => (i.resolvedUrl ? [i.resolvedUrl] : [])),
  ]);

  const fresh = normalized
    .filter((e) => !known.has(e.url))
    .sort(
      (a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)
    )
    .slice(0, NEW_PER_POLL);

  const ids: string[] = [];
  for (const e of fresh) {
    const row = await prisma.candidate
      .create({
        data: {
          userId,
          sourceId,
          url: e.url,
          title: e.title.slice(0, 300),
          excerpt: e.excerpt,
          publishedAt: e.publishedAt,
        },
        select: { id: true },
      })
      // Unique(userId, url) race with another source carrying the same
      // article: first writer wins, which is fine.
      .catch(() => null);
    if (row) ids.push(row.id);
  }
  return ids;
}

/**
 * Full-text extract + embed for one candidate.
 *
 * Full text rather than the feed summary because the semantic floor (0.22 in
 * search/embed.ts) was measured on full-article embeddings — summary-only
 * vectors score in a different range and would need their own calibration.
 * When extraction fails (paywall, JS-rendered page), we fall back to embedding
 * title + feed excerpt: a roughly-placed candidate still beats an invisible
 * one, and the floor keeps bad placements out of the panel.
 */
async function processCandidate(candidateId: string): Promise<void> {
  const candidate = await prisma.candidate
    .findUnique({ where: { id: candidateId } })
    .catch(() => null);
  if (!candidate) return;

  let embeddable: Parameters<typeof embeddableText>[0] = {
    title: candidate.title,
    excerpt: candidate.excerpt,
  };

  try {
    const article = await extractArticle(candidate.url);
    await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        title: article.title,
        siteName: article.siteName,
        excerpt: article.excerpt ?? candidate.excerpt,
        resolvedUrl: article.resolvedUrl,
        textContent: article.textContent,
        wordCount: article.wordCount,
        extractStatus: "ok",
        extractError: null,
      },
    });
    embeddable = {
      title: article.title,
      siteName: article.siteName,
      excerpt: article.excerpt,
      textContent: article.textContent,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.candidate
      .update({
        where: { id: candidateId },
        data: { extractStatus: "failed", extractError: message.slice(0, 300) },
      })
      .catch(() => {});
  }

  try {
    const vector = await embed(embeddableText(embeddable));
    await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        embedding: toBlob(vector),
        embeddingModel: EMBED_MODEL,
        embeddedAt: new Date(),
      },
    });
  } catch (err) {
    // Unembedded simply means "cannot be recommended yet"; the next poll
    // does not retry (the row exists), but a backfill can.
    console.warn(
      `[sources] embedding failed for candidate ${candidateId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/** Deletes unsaved candidates that aged out or overflowed the per-source cap. */
async function prune(sourceId: string): Promise<void> {
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  await prisma.candidate
    .deleteMany({
      where: { sourceId, savedItemId: null, firstSeenAt: { lt: cutoff } },
    })
    .catch(() => {});

  const overflow = await prisma.candidate
    .findMany({
      where: { sourceId, savedItemId: null },
      orderBy: { firstSeenAt: "desc" },
      skip: MAX_PER_SOURCE,
      select: { id: true },
    })
    .catch(() => []);
  if (overflow.length > 0) {
    await prisma.candidate
      .deleteMany({ where: { id: { in: overflow.map((c) => c.id) } } })
      .catch(() => {});
  }
}
