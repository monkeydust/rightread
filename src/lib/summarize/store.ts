import { prisma } from "@/lib/db";
import type { PreviousSummary } from "./prompts";

/**
 * The shape the reader gets. JSON columns are parsed here, once, so no
 * component ever sees a string that should have been a list.
 */
export type StoredSummary = {
  id: string;
  createdAt: Date;
  kind: string;
  tldr: string;
  points: string[];
  standout: string[];
  links: string[];
  verdict: string;
  sinceLast: string | null;
  sourceKind: string;
  fetchedAt: Date;
  commentCount: number | null;
  newComments: number | null;
  model: string;
  costUsd: number | null;
};

/** Newest first. Scoped by owner like every other read in this codebase. */
export async function listSummaries(userId: string, itemId: string): Promise<StoredSummary[]> {
  const rows = await prisma.itemSummary.findMany({
    where: { userId, itemId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    kind: r.kind,
    tldr: r.tldr,
    points: parseList(r.points),
    standout: parseList(r.standout),
    links: parseList(r.links),
    verdict: r.verdict,
    sinceLast: r.sinceLast,
    sourceKind: r.sourceKind,
    fetchedAt: r.fetchedAt,
    commentCount: r.commentCount,
    newComments: r.newComments,
    model: r.model,
    costUsd: r.costUsd,
  }));
}

export function asPrevious(s: StoredSummary | undefined): PreviousSummary | null {
  if (!s) return null;
  return {
    createdAt: s.createdAt,
    fetchedAt: s.fetchedAt,
    tldr: s.tldr,
    points: s.points,
    verdict: s.verdict,
    commentCount: s.commentCount,
  };
}

export async function saveSummary(data: {
  userId: string;
  itemId: string;
  kind: string;
  tldr: string;
  points: string[];
  standout: string[];
  links: string[];
  verdict: string;
  sinceLast: string | null;
  sourceKind: string;
  fetchedAt: Date;
  commentCount: number | null;
  newComments: number | null;
  textChars: number;
  model: string;
  costUsd: number | null;
  durationMs: number;
}): Promise<StoredSummary> {
  const row = await prisma.itemSummary.create({
    data: {
      ...data,
      points: JSON.stringify(data.points),
      standout: JSON.stringify(data.standout),
      links: JSON.stringify(data.links),
    },
  });
  return {
    ...data,
    id: row.id,
    createdAt: row.createdAt,
  };
}

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
