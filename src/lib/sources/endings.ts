/**
 * What the end of an article offers next.
 *
 * The old panel showed nearest candidates and nothing else — convergent by
 * construction, more of the same. This grades the offering by distance, using
 * the corpus's own measured bands (lib/graph/bands.ts), because the article
 * this feature came from is explicit that the *adjacent* and the *tangential*
 * are where incidental learning happens — and because "related" has already
 * been mismeasured twice in this codebase by guessing constants.
 *
 * One rule is load-bearing and deliberate: **candidates never appear in the
 * leap slot, and reach the step slot only over the precision floor.** The
 * comments in similar.ts record the measurement: candidate scores in the
 * 0.38–0.44 zone — which IS the moderate band — are where unrelated
 * frontpage pairs live. A weak connection between two articles the user chose
 * to save is a tangent; a weak connection to a random feed item is the junk
 * mode RIGHTREAD_REC_FLOOR exists to block.
 */

import { prisma } from "@/lib/db";
import { getUserMatrix } from "@/lib/search/matrix-cache";
import { getUserBands, type Bands } from "@/lib/graph/bands";
import {
  similarCandidates,
  ITEM_MATCH_FLOOR,
  type Recommendation,
} from "@/lib/sources/similar";

/** Near-duplicate guard, matching the graph's DUPLICATE_AT. */
const DUP = 0.99;

export type EndingSlot = {
  band: "step" | "leap" | "backlog";
  origin: "library" | "candidate";
  id: string;
  url: string;
  title: string;
  siteName: string | null;
  excerpt: string | null;
  wordCount: number | null;
  score: number;
  /** For the backlog microcopy ("You saved this 12 Jun"). */
  savedAt: Date | null;
  status: string | null;
};

export type ArticleEndings = {
  closest: Recommendation[];
  step: EndingSlot | null;
  leap: EndingSlot | null;
  backlog: EndingSlot | null;
  /** Whether a trail can start here (bands exist and the item is embedded). */
  trailReady: boolean;
};

type ScoredRow = { id: string; score: number; kind: string; status: string };

/**
 * The slot rules, pure so they can be tested without a database.
 *
 * Allocation order backlog → step → leap: backlog has the tightest constraint
 * (unread AND near), so it chooses first; each later slot excludes ids already
 * used. Every slot may come up empty, and an empty slot stays empty — the
 * panel renders absence, never padding.
 */
export function pickEndings(
  scored: ScoredRow[],
  currentKind: string,
  bands: Bands | null
): { backlogId: string | null; stepId: string | null; leapId: string | null } {
  const none = { backlogId: null, stepId: null, leapId: null };
  if (!bands) return none;

  const usable = scored.filter((r) => r.score < DUP);
  const used = new Set<string>();

  // Backlog: the best unread neighbour at or above the moderate cut. The
  // ITEM_MATCH_FLOOR fallback covers a corpus whose moderate band sits below
  // the measured precision floor — never offer "next door" below either.
  const backlogFloor = Math.max(bands.moderateAt, ITEM_MATCH_FLOOR);
  const backlog =
    usable
      .filter((r) => r.status === "unread" && r.score >= backlogFloor)
      .sort((a, b) => b.score - a.score)[0] ?? null;
  if (backlog) used.add(backlog.id);

  // Step: squarely inside the moderate band, best first.
  const step =
    usable
      .filter(
        (r) =>
          !used.has(r.id) &&
          r.score >= bands.moderateAt &&
          r.score < bands.strongAt
      )
      .sort((a, b) => b.score - a.score)[0] ?? null;
  if (step) used.add(step.id);

  // Leap: the window below moderate, preferring a different kind of page —
  // one comparator's worth of "a genuinely different direction". Within the
  // same kind-preference tier, the WEAKEST qualifying connection wins: the
  // slot is called a leap, so it should leap.
  const leap =
    usable
      .filter(
        (r) =>
          !used.has(r.id) && r.score >= bands.leapAt && r.score < bands.moderateAt
      )
      .sort((a, b) => {
        const aDiff = a.kind !== currentKind ? 0 : 1;
        const bDiff = b.kind !== currentKind ? 0 : 1;
        if (aDiff !== bDiff) return aDiff - bDiff;
        return a.score - b.score;
      })[0] ?? null;

  return {
    backlogId: backlog?.id ?? null,
    stepId: step?.id ?? null,
    leapId: leap?.id ?? null,
  };
}

/**
 * Everything the endings panel needs, in four bounded reads. Never throws:
 * any failure degrades to the closest-only panel, which is yesterday's
 * behaviour and still correct.
 */
export async function articleEndings(
  userId: string,
  itemId: string
): Promise<ArticleEndings> {
  const empty: ArticleEndings = {
    closest: [],
    step: null,
    leap: null,
    backlog: null,
    trailReady: false,
  };

  try {
    const [{ hits }, matrix, bands, current] = await Promise.all([
      similarCandidates(userId, itemId),
      getUserMatrix(userId),
      getUserBands(userId),
      prisma.item.findFirst({
        where: { id: itemId, userId },
        select: { kind: true },
      }),
    ]);

    const closest = hits.slice(0, 3);
    if (!current) return { ...empty, closest };

    // The article's own row is the query. If it was never embedded there is
    // no geometry to grade by; the panel is closest-only and no trail starts.
    const row = matrix.ids.indexOf(itemId);
    if (row === -1 || !bands) return { ...empty, closest };
    const base = row * matrix.dims;
    let alive = 0;
    for (let d = 0; d < matrix.dims; d++) alive += Math.abs(matrix.flat[base + d]);
    if (alive === 0) return { ...empty, closest };

    // One scan of the user's own library against this article.
    const scores: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < matrix.ids.length; i++) {
      if (i === row) continue;
      const bi = i * matrix.dims;
      let s = 0;
      for (let d = 0; d < matrix.dims; d++)
        s += matrix.flat[base + d] * matrix.flat[bi + d];
      if (s >= bands.leapAt) scores.push({ id: matrix.ids[i], score: s });
    }

    // Kind and status for the small qualifying pool only.
    const meta = scores.length
      ? await prisma.item.findMany({
          where: { userId, id: { in: scores.map((s) => s.id) } },
          select: { id: true, kind: true, status: true },
        })
      : [];
    const metaById = new Map(meta.map((m) => [m.id, m]));
    const scored: ScoredRow[] = scores.flatMap(({ id, score }) => {
      const m = metaById.get(id);
      return m ? [{ id, score, kind: m.kind, status: m.status }] : [];
    });

    const picked = pickEndings(scored, current.kind, bands);

    // Candidate fallback for the step slot: a leftover "closest" hit that
    // clears both the band and the precision floor. Leap never falls back.
    let stepCandidate: Recommendation | null = null;
    if (!picked.stepId) {
      stepCandidate =
        hits
          .slice(3)
          .find(
            (h) =>
              h.score >= Math.max(bands.moderateAt, ITEM_MATCH_FLOOR) &&
              h.score < bands.strongAt
          ) ?? null;
    }

    // Display metadata for the ≤3 winners.
    const winnerIds = [picked.backlogId, picked.stepId, picked.leapId].filter(
      (x): x is string => x !== null
    );
    const winners = winnerIds.length
      ? await prisma.item.findMany({
          where: { userId, id: { in: winnerIds } },
          select: {
            id: true,
            url: true,
            title: true,
            siteName: true,
            excerpt: true,
            wordCount: true,
            savedAt: true,
            status: true,
          },
        })
      : [];
    const winnerById = new Map(winners.map((w) => [w.id, w]));
    const scoreById = new Map(scores.map((s) => [s.id, s.score]));

    const slot = (
      id: string | null,
      band: EndingSlot["band"]
    ): EndingSlot | null => {
      if (!id) return null;
      const w = winnerById.get(id);
      if (!w) return null;
      return {
        band,
        origin: "library",
        id: w.id,
        url: w.url,
        title: w.title,
        siteName: w.siteName,
        excerpt: w.excerpt,
        wordCount: w.wordCount,
        score: scoreById.get(id) ?? 0,
        savedAt: w.savedAt,
        status: w.status,
      };
    };

    const step =
      slot(picked.stepId, "step") ??
      (stepCandidate
        ? {
            band: "step" as const,
            origin: "candidate" as const,
            id: stepCandidate.id,
            url: stepCandidate.url,
            title: stepCandidate.title,
            siteName: stepCandidate.siteName,
            excerpt: stepCandidate.excerpt,
            wordCount: stepCandidate.wordCount,
            score: stepCandidate.score,
            savedAt: null,
            status: null,
          }
        : null);

    return {
      closest,
      step,
      leap: slot(picked.leapId, "leap"),
      backlog: slot(picked.backlogId, "backlog"),
      trailReady: true,
    };
  } catch (err) {
    console.warn(
      `[endings] failed for item ${itemId}:`,
      err instanceof Error ? err.message : err
    );
    return empty;
  }
}
