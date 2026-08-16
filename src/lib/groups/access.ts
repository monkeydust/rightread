/**
 * Group visibility — the one place that reads group-scoped data.
 *
 * Every other model in this app is owned by exactly one user and read with
 * `where: { userId }`, checked inline at each of the ~34 places `auth()` is
 * called. Groups are the exception: what you may see is decided by
 * *membership*, not ownership. Two rules keep that exception from spreading.
 *
 * 1. Nothing outside this file queries `group`, `memberOf`, `groupShare` or
 *    `groupShareDismissal` directly. Routes call the helpers here.
 * 2. A share id is never trusted alone. `resolveShare` looks it up *and*
 *    checks membership of the group it belongs to, because a bare share id
 *    would otherwise be a handle into another club's shelf.
 *
 * Refusals are 404-shaped, not 403-shaped, matching how the rest of the app
 * treats a row you do not own: telling a stranger that a group exists but is
 * not theirs is more than they need to know.
 */

import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/allowlist";

/** Thrown when the caller is not in the group they asked about. Routes render it as 404. */
export class NotAMember extends Error {
  constructor() {
    super("Not found");
    this.name = "NotAMember";
  }
}

export async function isMember(userId: string, groupId: string): Promise<boolean> {
  const row = await prisma.memberOf.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { id: true },
  });
  return row !== null;
}

/** The gate. Call this before anything group-scoped. */
export async function requireMember(userId: string, groupId: string): Promise<void> {
  if (!(await isMember(userId, groupId))) throw new NotAMember();
}

export type GroupSummary = {
  id: string;
  name: string;
  memberCount: number;
  /** Shares this user has not dismissed — what the tab badge counts. */
  shelfCount: number;
};

/** Every group I'm in, oldest membership first. */
export async function listGroupsFor(userId: string): Promise<GroupSummary[]> {
  const memberships = await prisma.memberOf.findMany({
    where: { userId },
    orderBy: { joinedAt: "asc" },
    select: {
      group: {
        select: {
          id: true,
          name: true,
          _count: { select: { members: true, shares: true } },
        },
      },
    },
  });
  if (memberships.length === 0) return [];

  // One query for my dismissals across all my groups, rather than one per
  // group. Subtracting them from the share count is what makes the badge mean
  // "things waiting for me" instead of "things that exist".
  const dismissed = await prisma.groupShareDismissal.findMany({
    where: { userId, share: { groupId: { in: memberships.map((m) => m.group.id) } } },
    select: { share: { select: { groupId: true } } },
  });
  const dismissedPerGroup = new Map<string, number>();
  for (const { share } of dismissed) {
    dismissedPerGroup.set(share.groupId, (dismissedPerGroup.get(share.groupId) ?? 0) + 1);
  }

  return memberships.map(({ group }) => ({
    id: group.id,
    name: group.name,
    memberCount: group._count.members,
    shelfCount: Math.max(0, group._count.shares - (dismissedPerGroup.get(group.id) ?? 0)),
  }));
}

/**
 * Shares waiting for me across every group — the number on the Groups tab.
 *
 * One query rather than summing `listGroupsFor`, because the pages that want
 * the badge (the queue, the archive) have no other reason to load groups.
 */
export async function countGroupShares(userId: string): Promise<number> {
  return prisma.groupShare.count({
    where: {
      group: { members: { some: { userId } } },
      dismissals: { none: { userId } },
    },
  });
}

export type ShelfItem = {
  id: string;
  url: string;
  title: string;
  siteName: string | null;
  excerpt: string | null;
  leadImage: string | null;
  note: string | null;
  sharedAt: Date;
  /** Who shared it. Falls back to the label kept on the row if that account is gone. */
  sharedByEmail: string;
  sharedByMe: boolean;
  /** Set when this link is already in my library, so the card offers Read rather than Save. */
  savedItemId: string | null;
  /**
   * "unread" | "archived" when I already hold it.
   *
   * The shelf needs this because `captureUrl` resurfaces an existing URL — it
   * flips status back to unread and moves it to the top of the queue. Tapping
   * Save on something I read and archived in March would silently un-archive
   * it, and in a group whose taste overlaps with mine that is not an edge case.
   * Knowing the status lets the card say so instead.
   */
  savedStatus: string | null;
};

/**
 * A group's shelf as this member sees it — newest first, with their own
 * dismissals filtered out by the database rather than after the fact.
 */
export async function listShelf(userId: string, groupId: string): Promise<ShelfItem[]> {
  await requireMember(userId, groupId);

  const shares = await prisma.groupShare.findMany({
    where: { groupId, dismissals: { none: { userId } } },
    orderBy: { sharedAt: "desc" },
    select: {
      id: true,
      url: true,
      title: true,
      siteName: true,
      excerpt: true,
      leadImage: true,
      note: true,
      sharedAt: true,
      sharedByUserId: true,
      sharedByLabel: true,
      sharedBy: { select: { email: true } },
    },
  });
  if (shares.length === 0) return [];

  // Which of these I already hold, and in which pile. Cheap on the
  // @@unique([userId, url]) index, and it is what stops Save being a silent
  // un-archive — see the note on `savedStatus`.
  const mine = await prisma.item.findMany({
    where: { userId, url: { in: shares.map((s) => s.url) } },
    select: { id: true, url: true, status: true },
  });
  const savedByUrl = new Map(mine.map((i) => [i.url, i]));

  return shares.map((s) => ({
    id: s.id,
    url: s.url,
    title: s.title,
    siteName: s.siteName,
    excerpt: s.excerpt,
    leadImage: s.leadImage,
    note: s.note,
    sharedAt: s.sharedAt,
    sharedByEmail: s.sharedBy?.email ?? s.sharedByLabel ?? "someone",
    sharedByMe: s.sharedByUserId === userId,
    savedItemId: savedByUrl.get(s.url)?.id ?? null,
    savedStatus: savedByUrl.get(s.url)?.status ?? null,
  }));
}

/**
 * Resolves a share id to a share the caller is actually allowed to touch.
 *
 * Never look a share up by id alone — see the note at the top of this file.
 */
export async function resolveShare(userId: string, shareId: string) {
  const share = await prisma.groupShare.findUnique({
    where: { id: shareId },
    // sharedByUserId so a save can seed itself from the sharer's own extracted
    // copy — the only way a paywalled page they captured by hand is readable
    // for anyone else.
    select: {
      id: true,
      groupId: true,
      url: true,
      title: true,
      sharedByUserId: true,
      group: { select: { name: true } },
    },
  });
  if (!share) throw new NotAMember();
  await requireMember(userId, share.groupId);
  return share;
}

/** Member ids for SSE fan-out. */
export async function memberIdsOf(groupId: string): Promise<string[]> {
  const rows = await prisma.memberOf.findMany({
    where: { groupId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

export type MemberRow = { userId: string; email: string; joinedAt: Date; isMe: boolean };
export type InviteRow = { id: string; email: string; createdAt: Date };

/** Members and outstanding invites, for the group's people list. */
export async function listPeople(userId: string, groupId: string) {
  await requireMember(userId, groupId);

  const [members, invites] = await Promise.all([
    prisma.memberOf.findMany({
      where: { groupId },
      orderBy: { joinedAt: "asc" },
      select: { userId: true, joinedAt: true, user: { select: { email: true } } },
    }),
    prisma.groupInvite.findMany({
      where: { groupId },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, createdAt: true },
    }),
  ]);

  return {
    members: members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      joinedAt: m.joinedAt,
      isMe: m.userId === userId,
    })) satisfies MemberRow[],
    invites: invites satisfies InviteRow[],
  };
}

/**
 * Redeems any invitations waiting for an address, turning them into memberships.
 *
 * Called from the `signIn` callback once the allow list has already said yes,
 * and again when an invite is created for someone who already has an account —
 * so an invite lands immediately for an existing user and on first sign-in for
 * a new one, without those being two different code paths.
 *
 * Returns the group ids joined. Never throws: a failure here must not cost
 * someone their sign-in, the same contract classification and embedding honour
 * on the capture path.
 */
export async function redeemInvites(userId: string, rawEmail: string | null | undefined): Promise<string[]> {
  const email = normalizeEmail(rawEmail);
  if (!email) return [];

  try {
    const invites = await prisma.groupInvite.findMany({
      where: { email },
      select: { id: true, groupId: true },
    });
    if (invites.length === 0) return [];

    const joined: string[] = [];
    for (const invite of invites) {
      // createMany with skipDuplicates would be one statement, but doing these
      // one at a time means an invite to a group they somehow already joined
      // still gets cleaned up rather than aborting the batch.
      try {
        await prisma.memberOf.upsert({
          where: { groupId_userId: { groupId: invite.groupId, userId } },
          create: { groupId: invite.groupId, userId },
          update: {},
        });
        await prisma.groupInvite.delete({ where: { id: invite.id } });
        joined.push(invite.groupId);
      } catch (err) {
        console.warn(
          `[groups] could not redeem invite ${invite.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    return joined;
  } catch (err) {
    console.warn(
      "[groups] invite redemption failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}
