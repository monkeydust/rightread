/**
 * Storing a device's push subscription, and a user's choices.
 *
 * An endpoint is a capability: whoever holds it can make that device show a
 * notification. So it is validated before it is stored (`isPushEndpoint`),
 * never returned to a client, and never logged. The Settings page tells a
 * device whether it is registered by comparing a SHA-256 of its endpoint, so
 * the page of one device never carries another device's endpoint.
 */

import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { deviceLabel } from "./core";
import { isNotificationTypeId, resolvePreferences } from "./types";
import { isPushEndpoint, validSubscriptionKeys } from "./webpush";

/** More than this and the oldest go: nobody has ten phones, a bug might. */
const MAX_DEVICES_PER_USER = 10;

export function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

/**
 * The `Session` row behind this request, so a subscription can be tied to it
 * and removed with it at sign-out. Auth.js names the cookie differently over
 * https. Null when it cannot be found; the subscription is then simply not
 * tied to a session.
 */
async function currentSessionId(userId: string): Promise<string | null> {
  try {
    const jar = await cookies();
    const token =
      jar.get("__Secure-authjs.session-token")?.value ?? jar.get("authjs.session-token")?.value;
    if (!token) return null;
    const row = await prisma.session.findUnique({
      where: { sessionToken: token },
      select: { id: true, userId: true },
    });
    return row && row.userId === userId ? row.id : null;
  } catch {
    return null;
  }
}

export type SubscriptionInput = { endpoint: unknown; p256dh: unknown; auth: unknown };

/**
 * Registers this device for a user. Idempotent: the same endpoint again
 * updates the row. An endpoint that was registered to someone else moves to
 * this user — the phone has changed hands, or accounts.
 *
 * @returns false when the subscription is not one we will ever send to.
 */
export async function saveSubscription(
  userId: string,
  input: SubscriptionInput,
  userAgent: string | null
): Promise<boolean> {
  if (!isPushEndpoint(input.endpoint)) return false;
  if (!validSubscriptionKeys(input.p256dh, input.auth)) return false;

  const data = {
    userId,
    sessionId: await currentSessionId(userId),
    p256dh: input.p256dh as string,
    auth: input.auth as string,
    label: deviceLabel(userAgent),
  };
  await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: { endpoint: input.endpoint, ...data },
    update: data,
  });

  const extra = await prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: MAX_DEVICES_PER_USER,
    select: { id: true },
  });
  if (extra.length) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: extra.map((r) => r.id) } } });
  }
  return true;
}

/** Switches this device off. Only ever the caller's own row. */
export async function removeSubscription(userId: string, endpoint: unknown): Promise<void> {
  if (typeof endpoint !== "string") return;
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
}

/** The caller's own subscription for an endpoint, for the test button. */
export async function ownSubscription(userId: string, endpoint: unknown) {
  if (typeof endpoint !== "string") return null;
  return prisma.pushSubscription.findFirst({
    where: { userId, endpoint },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
}

/** Everything the Settings section needs, with no endpoint in it. */
export async function notificationSettings(userId: string) {
  const [devices, stored] = await Promise.all([
    prisma.pushSubscription.findMany({ where: { userId }, select: { endpoint: true } }),
    prisma.notificationPreference.findMany({
      where: { userId },
      select: { type: true, enabled: true },
    }),
  ]);
  return {
    deviceHashes: devices.map((d) => endpointHash(d.endpoint)),
    types: resolvePreferences(stored).map(({ id, label, description, enabled }) => ({
      id,
      label,
      description,
      enabled,
    })),
  };
}

/** Records a choice for one type. @returns false for a type that does not exist. */
export async function setPreference(
  userId: string,
  type: unknown,
  enabled: unknown
): Promise<boolean> {
  if (!isNotificationTypeId(type) || typeof enabled !== "boolean") return false;
  await prisma.notificationPreference.upsert({
    where: { userId_type: { userId, type } },
    create: { userId, type, enabled },
    update: { enabled },
  });
  return true;
}
