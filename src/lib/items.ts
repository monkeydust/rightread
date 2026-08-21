import { prisma } from "@/lib/db";

/** The columns the list needs — deliberately excludes contentHtml, which is large. */
const LIST_FIELDS = {
  id: true,
  url: true,
  title: true,
  siteName: true,
  byline: true,
  excerpt: true,
  leadImage: true,
  wordCount: true,
  extractStatus: true,
  extractError: true,
  status: true,
  starred: true,
  kind: true,
  kindConfidence: true,
  kindSource: true,
  position: true,
  progress: true,
  recommended: true,
  fromGroupId: true,
  fromGroupName: true,
  savedAt: true,
} as const;

export type ListItem = {
  id: string;
  url: string;
  title: string;
  siteName: string | null;
  byline: string | null;
  excerpt: string | null;
  leadImage: string | null;
  wordCount: number | null;
  extractStatus: string;
  extractError: string | null;
  status: string;
  starred: boolean;
  kind: string;
  kindConfidence: number;
  kindSource: string;
  position: number;
  progress: number;
  recommended: boolean;
  /** Set when this was saved off a group's shelf. Provenance for the list chip. */
  fromGroupId: string | null;
  /** Kept beside the id so the chip survives leaving or deleting the group. */
  fromGroupName: string | null;
  savedAt: Date;
};

/** One queue, in position order. Starring is a marker and does not sort. */
export async function listItems(
  userId: string,
  status: "unread" | "archived" = "unread"
): Promise<ListItem[]> {
  return prisma.item.findMany({
    where: { userId, status },
    orderBy: [{ position: "asc" }, { savedAt: "desc" }],
    select: LIST_FIELDS,
  });
}

export async function getItem(userId: string, id: string) {
  return prisma.item.findFirst({ where: { id, userId } });
}

/**
 * Every item id, unread first, for the offline precache.
 *
 * Unread before archived because the precache is capped: if a library is large
 * enough to be truncated, the things still to read are the ones worth having on
 * a plane. Ids only — this is a list of what to download, not the download.
 */
export async function allItemIds(userId: string): Promise<string[]> {
  const rows = await prisma.item.findMany({
    where: { userId },
    orderBy: [{ position: "asc" }, { savedAt: "desc" }],
    select: { id: true, status: true },
  });
  return [
    ...rows.filter((r) => r.status === "unread"),
    ...rows.filter((r) => r.status !== "unread"),
  ].map((r) => r.id);
}

export async function countByStatus(userId: string) {
  const [unread, archived] = await Promise.all([
    prisma.item.count({ where: { userId, status: "unread" } }),
    prisma.item.count({ where: { userId, status: "archived" } }),
  ]);
  return { unread, archived };
}
