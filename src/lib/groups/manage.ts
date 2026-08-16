/**
 * Creating groups and moving people in and out of them.
 *
 * There are no roles: every member may rename the group, invite, and remove
 * anyone. That is a deliberate choice for a handful of people who already trust
 * each other, and it is why none of these functions take an "actor is allowed
 * to do this" argument beyond `requireMember`.
 */

import { prisma } from "@/lib/db";
import { normalizeEmail, isEmailAllowed } from "@/lib/allowlist";
import { publishToAll } from "@/lib/events";
import { memberIdsOf, requireMember } from "./access";
import { normalizeGroupName } from "./rules";

export class InvalidGroupName extends Error {
  constructor() {
    super("A group needs a name");
    this.name = "InvalidGroupName";
  }
}

export class InvalidEmail extends Error {
  constructor() {
    super("That does not look like an email address");
    this.name = "InvalidEmail";
  }
}

/** Creates a group with its creator as the first member. */
export async function createGroup(userId: string, rawName: string) {
  const name = normalizeGroupName(rawName);
  if (!name) throw new InvalidGroupName();

  return prisma.group.create({
    data: { name, members: { create: { userId } } },
    select: { id: true, name: true },
  });
}

export async function renameGroup(userId: string, groupId: string, rawName: string) {
  await requireMember(userId, groupId);

  const name = normalizeGroupName(rawName);
  if (!name) throw new InvalidGroupName();

  const group = await prisma.group.update({
    where: { id: groupId },
    data: { name },
    select: { id: true, name: true },
  });

  publishToAll(await memberIdsOf(groupId), {
    type: "groups-changed",
    cause: "membership",
    groupId,
  });
  return group;
}

export type InviteResult = {
  status: "joined" | "invited" | "already-member";
  email: string;
  /**
   * False when the address is not on RIGHTREAD_ALLOWED_EMAILS and therefore
   * cannot sign in yet. Computed fresh every time it is asked for, never
   * stored, so fixing the env var fixes the display without touching the row.
   */
  canSignIn: boolean;
};

/**
 * Invites an address to a group.
 *
 * Someone who already has an account is joined outright. Someone who does not
 * gets a `GroupInvite` row, redeemed by the `events.signIn` hook in `src/auth.ts`
 * the first time they sign in.
 *
 * An address that is not on the allow list is still accepted, and this is the
 * considered choice rather than an oversight. Refusing it would leak who is on
 * the list to anyone who can type an address, and would break the ordinary
 * "invite them now, edit the env file tonight" order of operations. Instead the
 * result carries `canSignIn: false` and the caller is expected to say so —
 * an invite that silently does nothing is the failure worth avoiding here.
 */
export async function inviteToGroup(
  userId: string,
  groupId: string,
  rawEmail: string
): Promise<InviteResult> {
  await requireMember(userId, groupId);

  const email = normalizeEmail(rawEmail);
  if (!email) throw new InvalidEmail();

  const canSignIn = isEmailAllowed(email);
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    const already = await prisma.memberOf.findUnique({
      where: { groupId_userId: { groupId, userId: existing.id } },
      select: { id: true },
    });
    if (already) return { status: "already-member", email, canSignIn };

    await prisma.memberOf.create({ data: { groupId, userId: existing.id } });
    publishToAll(await memberIdsOf(groupId), {
      type: "groups-changed",
      cause: "membership",
      groupId,
    });
    return { status: "joined", email, canSignIn };
  }

  await prisma.groupInvite.upsert({
    where: { groupId_email: { groupId, email } },
    create: { groupId, email, invitedBy: userId },
    update: {},
  });
  return { status: "invited", email, canSignIn };
}

export async function revokeInvite(userId: string, groupId: string, inviteId: string) {
  await requireMember(userId, groupId);
  // Scoped by groupId as well as id: an invite id alone must not be a handle
  // into another group's invite list.
  await prisma.groupInvite.deleteMany({ where: { id: inviteId, groupId } });
}

/**
 * Removes someone from a group.
 *
 * Their own library is untouched — anything they saved is a normal Item of
 * theirs — and their past shares stay on the shelf, because the group owns
 * those. Only access goes away.
 */
export async function removeMember(userId: string, groupId: string, targetUserId: string) {
  await requireMember(userId, groupId);

  if (targetUserId === userId) {
    // Leaving is its own operation, because it has to handle being the last one out.
    return leaveGroup(userId, groupId);
  }

  const removed = await prisma.memberOf.deleteMany({
    where: { groupId, userId: targetUserId },
  });
  if (removed.count === 0) return { deletedGroup: false };

  publishToAll([...(await memberIdsOf(groupId)), targetUserId], {
    type: "groups-changed",
    cause: "membership",
    groupId,
  });
  return { deletedGroup: false };
}

/**
 * Leaves a group, deleting it if that was the last member.
 *
 * A group nobody is in is unreachable — there is no admin view and no way back
 * in — so keeping the row would only leave rows and pending invites behind for
 * a shelf no one can open. SQLite's single writer makes the "two people leave
 * at once" race a non-issue.
 */
export async function leaveGroup(userId: string, groupId: string) {
  await requireMember(userId, groupId);

  const others = await memberIdsOf(groupId);
  const remaining = others.filter((id) => id !== userId);

  await prisma.$transaction(async (tx) => {
    await tx.memberOf.deleteMany({ where: { groupId, userId } });
    if (remaining.length === 0) {
      // Cascades shares, dismissals and pending invites.
      await tx.group.delete({ where: { id: groupId } });
    }
  });

  publishToAll([...remaining, userId], {
    type: "groups-changed",
    cause: "membership",
    groupId,
  });
  return { deletedGroup: remaining.length === 0 };
}
