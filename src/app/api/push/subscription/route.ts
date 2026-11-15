import { auth } from "@/auth";
import { notificationsAvailable } from "@/lib/notify";
import { removeSubscription, saveSubscription } from "@/lib/notify/subscriptions";

export const dynamic = "force-dynamic";

/**
 * POST /api/push/subscription { endpoint, keys: { p256dh, auth } }
 *
 * Registers this device, in the shape `PushSubscription.toJSON()` gives.
 * Session cookie only: a subscription belongs to a signed-in browser, never
 * to a capture token. Idempotent.
 */
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!notificationsAvailable()) {
    return Response.json({ error: "Notifications are not set up on this server" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const ok = await saveSubscription(
    userId,
    { endpoint: body?.endpoint, p256dh: body?.keys?.p256dh, auth: body?.keys?.auth },
    request.headers.get("user-agent")
  );
  if (!ok) return Response.json({ error: "Not a push subscription" }, { status: 400 });
  return Response.json({ ok: true });
}

/** DELETE /api/push/subscription { endpoint } — switches this device off. Idempotent. */
export async function DELETE(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  await removeSubscription(userId, body?.endpoint);
  return Response.json({ ok: true });
}
