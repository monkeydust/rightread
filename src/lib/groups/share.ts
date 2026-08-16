/**
 * Putting links on a shelf, and taking them off your own view of it.
 *
 * Writes only. Reads live in `./access.ts`; both go through `requireMember`
 * before touching anything.
 */

import { prisma } from "@/lib/db";
import { normalizeUrl, hostLabel } from "@/lib/url";
import { captureUrl } from "@/lib/capture";
import { publishToAll, publish } from "@/lib/events";
import { memberIdsOf, requireMember, resolveShare } from "./access";
import { snapshotFromItem, isBetterSnapshot } from "./rules";

/** Thrown when someone tries to share a link they have not saved. Routes render it as 400. */
export class NotInLibrary extends Error {
  constructor() {
    super("You can only share something that's in your queue or archive");
    this.name = "NotInLibrary";
  }
}

/**
 * Shares a URL into a group.
 *
 * **The link must already be in the sharer's own library.** A group shelf is
 * meant to be things people have actually chosen to read, not a paste box
 * pointed at the internet, and the rule is enforced here rather than by hiding
 * the UI — otherwise it is a convention that the first direct API call breaks.
 * It also means the snapshot always comes from an Item that exists, so the
 * shelf is populated without a second fetch of the origin.
 *
 * Re-sharing an existing link refreshes it rather than duplicating: `sharedAt`
 * moves, and every member's dismissal of it is cleared, which is what makes
 * re-sharing a way to put something back in front of the group.
 */
export async function shareIntoGroup(
  userId: string,
  groupId: string,
  rawUrl: string,
  note?: string | null
) {
  await requireMember(userId, groupId);

  const url = normalizeUrl(rawUrl);
  const fallbackTitle = hostLabel(url);

  const [mine, me] = await Promise.all([
    prisma.item.findUnique({
      where: { userId_url: { userId, url } },
      select: { title: true, siteName: true, excerpt: true, leadImage: true, extractStatus: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);
  if (!mine) throw new NotInLibrary();

  const snapshot = snapshotFromItem(mine, fallbackTitle);
  const trimmedNote = note?.trim() || null;

  // Only claim the snapshot is real once extraction has actually produced
  // something. Sharing straight after saving is the normal flow, and at that
  // moment the item is still a hostname and a pending status.
  const snapshotAt = mine?.extractStatus === "ok" ? new Date() : null;

  const existing = await prisma.groupShare.findUnique({
    where: { groupId_url: { groupId, url } },
    select: { id: true, title: true, siteName: true, excerpt: true, leadImage: true },
  });

  let share;
  if (existing) {
    // Do not let a re-share downgrade a good card to a bare hostname — see
    // isBetterSnapshot. Attribution and time always move to the latest sharer.
    const keep = !isBetterSnapshot(snapshot, {
      title: existing.title,
      siteName: existing.siteName,
      excerpt: existing.excerpt,
      leadImage: existing.leadImage,
    });
    share = await prisma.groupShare.update({
      where: { id: existing.id },
      data: {
        sharedByUserId: userId,
        sharedByLabel: me?.email ?? "",
        sharedAt: new Date(),
        // An empty note never wipes the one already there — re-sharing someone
        // else's link should not silently erase what they said about it.
        ...(trimmedNote ? { note: trimmedNote } : {}),
        ...(keep ? {} : { ...snapshot, snapshotAt }),
      },
    });
    // Back in front of everyone who had put it away. This is what makes
    // re-sharing the way to say "no, really, read this".
    await prisma.groupShareDismissal.deleteMany({ where: { shareId: existing.id } });
  } else {
    share = await prisma.groupShare.create({
      data: {
        groupId,
        sharedByUserId: userId,
        sharedByLabel: me?.email ?? "",
        url,
        note: trimmedNote,
        snapshotAt,
        ...snapshot,
      },
    });
  }

  publishToAll(await memberIdsOf(groupId), {
    type: "groups-changed",
    cause: "shared",
    groupId,
  });

  return share;
}

/**
 * Fills in shelf cards for a link whose extraction has just finished.
 *
 * Without this, the common case produces a permanently bad card. `captureUrl`
 * returns before extraction runs, so an item is a bare hostname for the first
 * second or two of its life — and sharing something you just saved is the
 * normal flow, not an edge case. Nothing else ever revisits a `GroupShare`, so
 * whatever was true at that moment would be what the group saw forever.
 *
 * Only touches cards that were never filled from a real extraction
 * (`snapshotAt: null`), so it can improve a thin card but never downgrade a
 * good one. `updateMany`, because one link can sit on several shelves.
 *
 * Fail-soft and detached, like the recommendation hook it sits beside: a
 * capture must not fail because a shelf card could not be tidied.
 */
export async function backfillSharesForItem(
  userId: string,
  urls: string | string[],
  snapshot: { title: string; siteName: string | null; excerpt: string | null; leadImage: string | null }
): Promise<void> {
  try {
    const candidates = [...new Set(Array.isArray(urls) ? urls : [urls])].filter(Boolean);
    if (candidates.length === 0) return;

    const stale = await prisma.groupShare.findMany({
      where: { sharedByUserId: userId, url: { in: candidates }, snapshotAt: null },
      select: { id: true, groupId: true },
    });
    if (stale.length === 0) return;

    await prisma.groupShare.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: {
        title: snapshot.title,
        siteName: snapshot.siteName,
        excerpt: snapshot.excerpt,
        leadImage: snapshot.leadImage,
        snapshotAt: new Date(),
      },
    });

    // Tell each affected shelf so an open tab picks up the real title rather
    // than sitting on the hostname until someone navigates.
    for (const groupId of new Set(stale.map((s) => s.groupId))) {
      publishToAll(await memberIdsOf(groupId), {
        type: "groups-changed",
        cause: "shared",
        groupId,
      });
    }
  } catch (err) {
    console.warn(
      `[groups] snapshot backfill failed for ${Array.isArray(urls) ? urls[0] : urls}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Saves a shared link into my own library.
 *
 * Deliberately just `captureUrl` — the same path the share sheet, the extension
 * and the paste box use. The saved row is an ordinary Item, which is why
 * ordering, starring, search, the graph and the reader need no group-awareness
 * at all. Extraction runs again for me rather than being copied from the
 * sharer, so what I hold is mine and independent of what they later do.
 */
export async function saveShare(userId: string, shareId: string) {
  const share = await resolveShare(userId, shareId);
  const { item, alreadySaved } = await captureUrl(userId, share.url);
  return { item, alreadySaved, groupId: share.groupId };
}

/** Hides a share from my own shelf. Everyone else still sees it. */
export async function dismissShare(userId: string, shareId: string) {
  const share = await resolveShare(userId, shareId);

  await prisma.groupShareDismissal.upsert({
    where: { shareId_userId: { shareId: share.id, userId } },
    create: { shareId: share.id, userId },
    update: {},
  });

  // Only I need to know — a dismissal changes nobody else's shelf.
  publish(userId, { type: "groups-changed", cause: "dismissed", groupId: share.groupId });
  return share;
}

/** Puts a share I had dismissed back on my shelf. */
export async function undismissShare(userId: string, shareId: string) {
  const share = await resolveShare(userId, shareId);
  await prisma.groupShareDismissal.deleteMany({ where: { shareId: share.id, userId } });
  publish(userId, { type: "groups-changed", cause: "dismissed", groupId: share.groupId });
  return share;
}

/**
 * Removes a share from the shelf entirely — only the person who put it there.
 *
 * Dismissal is the action everyone has; this is the narrow "I take that back"
 * for your own share. Not exposed as a member-on-member power, because groups
 * have no roles and one member silently deleting another's link would be one.
 */
export async function unshare(userId: string, shareId: string) {
  const share = await prisma.groupShare.findUnique({
    where: { id: shareId },
    select: { id: true, groupId: true, sharedByUserId: true },
  });
  if (!share) return null;
  await requireMember(userId, share.groupId);
  if (share.sharedByUserId !== userId) return null;

  await prisma.groupShare.delete({ where: { id: share.id } });
  publishToAll(await memberIdsOf(share.groupId), {
    type: "groups-changed",
    cause: "removed",
    groupId: share.groupId,
  });
  return share;
}
