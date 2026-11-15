/**
 * Notifications — the part with a database and a network in it.
 *
 *   notify("group_share", userIds, message)
 *
 * is the whole API for sending. It returns at once and never throws; the
 * work runs detached, so the request that caused it is neither slowed nor
 * failed by it. With no VAPID keys configured nothing is read and nothing is
 * sent. The rules themselves (who, what, counting) are in `./core.ts`.
 */

import { prisma } from "@/lib/db";
import {
  dispatch,
  groupShareMessage,
  othersInGroup,
  pushChannel,
  type Channel,
  type DispatchResult,
  type Message,
  type PushStore,
} from "./core";
import type { NotificationTypeId } from "./types";
import { readVapidConfig, sendPush, type VapidConfig } from "./webpush";

/** Read on each use, not at import: a test or a restart may change it, and it is cheap. */
export function vapidConfig(): VapidConfig | null {
  return readVapidConfig();
}

/** Whether this server can send notifications at all. */
export function notificationsAvailable(): boolean {
  return vapidConfig() !== null;
}

const store: PushStore = {
  async targets(userId) {
    return prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  },
  async remove(ids) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: ids } } });
  },
  async touch(ids) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: ids } },
      data: { lastSentAt: new Date() },
    });
  },
};

const push: Channel = pushChannel({
  available: notificationsAvailable,
  store,
  async send(target, payload) {
    const config = vapidConfig();
    return config ? sendPush(target, payload, config) : "failed";
  },
});

/** Every channel there is. A second one (email, say) is added to this list. */
const CHANNELS: readonly Channel[] = [push];

/** As `notify`, but awaited. For callers that report the outcome (the test button). */
export function notifyNow(
  typeId: NotificationTypeId,
  userIds: readonly string[],
  message: Message
): Promise<DispatchResult> {
  return dispatch(
    {
      channels: CHANNELS,
      async preferences(type, ids) {
        return prisma.notificationPreference.findMany({
          where: { type, userId: { in: ids } },
          select: { userId: true, enabled: true },
        });
      },
      log: (line) => console.log(line),
    },
    typeId,
    userIds,
    message
  );
}

/**
 * Sends a notification to some users. Detached and fail-soft: returns
 * immediately, never throws, never rejects.
 */
export function notify(
  typeId: NotificationTypeId,
  userIds: readonly string[],
  message: Message
): void {
  if (!notificationsAvailable() || userIds.length === 0) return;
  void notifyNow(typeId, userIds, message).catch(() => {});
}

/**
 * Tells a group's other members that something was shared.
 *
 * Called by `shareIntoGroup` once the share is stored. The member list and
 * the group's name are handed in by that function, which read them through
 * `groups/access.ts`; nothing group-scoped is queried here. Never throws.
 */
export function notifyGroupShare(input: {
  groupId: string;
  groupName: string;
  memberIds: readonly string[];
  sharerId: string;
  share: { id: string; title: string; url: string };
}): void {
  if (!notificationsAvailable()) return;
  const recipients = othersInGroup(input.memberIds, input.sharerId);
  if (recipients.length === 0) return;

  void (async () => {
    const sharer = await prisma.user
      .findUnique({ where: { id: input.sharerId }, select: { name: true, email: true } })
      .catch(() => null);
    await notifyNow(
      "group_share",
      recipients,
      groupShareMessage({
        groupId: input.groupId,
        groupName: input.groupName,
        shareId: input.share.id,
        sharerName: sharer?.name ?? null,
        sharerEmail: sharer?.email ?? null,
        title: input.share.title,
        url: input.share.url,
      })
    );
  })().catch(() => {});
}
