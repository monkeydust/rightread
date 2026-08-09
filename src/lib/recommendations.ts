/**
 * The read model behind Discover.
 *
 * Recommendation rows record *why* a candidate surfaced; this turns them into
 * something renderable: groups, each headed by the phrase or the article that
 * produced it.
 *
 * A candidate can legitimately match several origins. It is shown once, under
 * its strongest, because "you already saw this two groups up" is noise and
 * because a duplicate makes the count in the tab a lie.
 */

import { prisma } from "@/lib/db";

export type DiscoverHit = {
  recommendationId: string;
  candidateId: string;
  url: string;
  title: string;
  siteName: string | null;
  excerpt: string | null;
  wordCount: number | null;
  publishedAt: Date | null;
  sourceTitle: string | null;
  score: number;
};

export type DiscoverGroup = {
  key: string;
  kind: "phrase" | "item";
  /** The phrase text, or the title of the article that matched. */
  label: string;
  hits: DiscoverHit[];
};

export type NearMiss = {
  phrase: string;
  /** Best few that did not clear the floor, strongest first. */
  closest: Array<{ title: string; url: string; score: number }>;
  floor: number;
};

export type DiscoverPayload = {
  groups: DiscoverGroup[];
  /** Undismissed, unsaved recommendations — what the tab badge counts. */
  total: number;
  /** True when the user has not defined any phrase yet: a different empty state. */
  hasPhrases: boolean;
  hasSources: boolean;
  /**
   * For phrases that matched nothing, what came closest.
   *
   * An empty Discover is indistinguishable from a broken one, and the honest
   * answer — "it ran, and nothing was close enough" — is invisible without
   * this. Showing the near misses with their scores also lets the reader judge
   * whether the bar is set where they want it, rather than taking it on faith.
   */
  nearMisses: NearMiss[];
};

const MAX_GROUPS = 20;

export async function getDiscover(userId: string): Promise<DiscoverPayload> {
  const [phrases, sourceCount] = await Promise.all([
    prisma.keyPhrase.findMany({
      where: { userId },
      select: { id: true, text: true, active: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.source.count({ where: { userId } }),
  ]);

  const rows = await prisma.recommendation.findMany({
    where: {
      userId,
      // Dismissed and saved candidates are excluded here rather than at write
      // time: the rows stay as a record of what matched, but a decision the
      // user has already made must not come back.
      candidate: { dismissedAt: null, savedItemId: null },
    },
    orderBy: { score: "desc" },
    select: {
      id: true,
      score: true,
      originKind: true,
      originId: true,
      candidateId: true,
      candidate: {
        select: {
          url: true,
          title: true,
          siteName: true,
          excerpt: true,
          wordCount: true,
          publishedAt: true,
          source: { select: { title: true } },
        },
      },
    },
  });

  // Rows arrive strongest first, so the first sighting of a candidate is its
  // best one — later duplicates are dropped.
  const seen = new Set<string>();
  const byOrigin = new Map<string, DiscoverHit[]>();
  for (const r of rows) {
    if (seen.has(r.candidateId)) continue;
    seen.add(r.candidateId);
    const key = `${r.originKind}:${r.originId}`;
    if (!byOrigin.has(key)) byOrigin.set(key, []);
    byOrigin.get(key)!.push({
      recommendationId: r.id,
      candidateId: r.candidateId,
      url: r.candidate.url,
      title: r.candidate.title,
      siteName: r.candidate.siteName,
      excerpt: r.candidate.excerpt,
      wordCount: r.candidate.wordCount,
      publishedAt: r.candidate.publishedAt,
      sourceTitle: r.candidate.source?.title ?? null,
      score: r.score,
    });
  }

  // Label the item-origin groups. One query rather than one per group.
  const itemIds = [...byOrigin.keys()]
    .filter((k) => k.startsWith("item:"))
    .map((k) => k.slice("item:".length));
  const items = itemIds.length
    ? await prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, title: true },
      })
    : [];
  const itemTitles = new Map(items.map((i) => [i.id, i.title]));
  const phraseTexts = new Map(phrases.map((p) => [p.id, p.text]));

  const groups: DiscoverGroup[] = [];
  for (const [key, hits] of byOrigin) {
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const label =
      kind === "phrase" ? phraseTexts.get(id) : itemTitles.get(id);
    // An origin whose phrase or item has since been deleted: the cascade
    // removes the rows, but a sweep mid-delete could leave one behind.
    if (!label) continue;
    groups.push({ key, kind: kind as "phrase" | "item", label, hits });
  }

  // Phrase groups first — they are the standing interest the user declared,
  // where article groups are a by-product of something they already read.
  groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "phrase" ? -1 : 1;
    return (b.hits[0]?.score ?? 0) - (a.hits[0]?.score ?? 0);
  });

  const matched = new Set(
    groups.filter((g) => g.kind === "phrase").map((g) => g.key.slice("phrase:".length))
  );
  const nearMisses = await computeNearMisses(
    userId,
    phrases.filter((p) => p.active && !matched.has(p.id))
  );

  return {
    groups: groups.slice(0, MAX_GROUPS),
    total: seen.size,
    hasPhrases: phrases.some((p) => p.active),
    hasSources: sourceCount > 0,
    nearMisses,
  };
}

/** How many near misses to show per phrase. Enough to judge, few enough to skim. */
const NEAR_MISS_COUNT = 3;

/**
 * Scores phrases that found nothing, purely to report what came closest.
 *
 * This deliberately repeats the work the sweep already did rather than storing
 * sub-floor scores: a near miss is worth nothing once anything clears the bar,
 * and persisting every rejected pair would mean writing hundreds of rows per
 * phrase per poll to display three of them.
 */
async function computeNearMisses(
  userId: string,
  phrases: Array<{ id: string; text: string }>
): Promise<NearMiss[]> {
  if (phrases.length === 0) return [];

  const { fromBlob, cosine } = await import("@/lib/search/embed");
  const { PHRASE_FLOOR } = await import("@/lib/phrases/match");

  const [withVectors, candidates] = await Promise.all([
    prisma.keyPhrase.findMany({
      where: { id: { in: phrases.map((p) => p.id) }, embedding: { not: null } },
      select: { id: true, text: true, embedding: true },
    }),
    prisma.candidate.findMany({
      where: { userId, embedding: { not: null }, dismissedAt: null, savedItemId: null },
      select: { title: true, url: true, embedding: true },
    }),
  ]);
  if (candidates.length === 0) return [];

  return withVectors.map((p) => {
    const q = fromBlob(p.embedding!);
    const closest = candidates
      .map((c) => ({
        title: c.title,
        url: c.url,
        score: cosine(q, fromBlob(c.embedding!)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, NEAR_MISS_COUNT);
    return { phrase: p.text, closest, floor: PHRASE_FLOOR };
  });
}

/** Cheap count for the nav badge — no candidate bodies loaded. */
export async function countDiscover(userId: string): Promise<number> {
  const rows = await prisma.recommendation.findMany({
    where: { userId, candidate: { dismissedAt: null, savedItemId: null } },
    select: { candidateId: true },
  });
  // Distinct candidates, matching what Discover actually renders.
  return new Set(rows.map((r) => r.candidateId)).size;
}
