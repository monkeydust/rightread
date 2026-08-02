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
  position: true,
  progress: true,
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
  position: number;
  progress: number;
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

export async function countByStatus(userId: string) {
  const [unread, archived] = await Promise.all([
    prisma.item.count({ where: { userId, status: "unread" } }),
    prisma.item.count({ where: { userId, status: "archived" } }),
  ]);
  return { unread, archived };
}
