import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { vapidConfig } from "@/lib/notify";
import { pushPayload, testMessage } from "@/lib/notify/core";
import { ownSubscription } from "@/lib/notify/subscriptions";
import { sendPush } from "@/lib/notify/webpush";

export const dynamic = "force-dynamic";

/** One test a minute per user. In-process, like the rest of this single-container app. */
const COOLDOWN_MS = 60_000;
const lastTest = new Map<string, number>();

/**
 * POST /api/push/test { endpoint } — sends a test notification to this device.
 *
 * Only to the caller's own registered device, so it cannot be used to send
 * anything anywhere else. Not fail-soft: the user pressed a button, so the
 * answer says what happened.
 */
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const config = vapidConfig();
  if (!config) {
    return Response.json({ error: "Notifications are not set up on this server" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const device = await ownSubscription(userId, body?.endpoint);
  if (!device) {
    return Response.json({ error: "This device is not switched on" }, { status: 404 });
  }

  const now = Date.now();
  const wait = COOLDOWN_MS - (now - (lastTest.get(userId) ?? 0));
  if (wait > 0) {
    return Response.json(
      { error: `Wait ${Math.ceil(wait / 1000)} seconds before sending another` },
      { status: 429 }
    );
  }
  lastTest.set(userId, now);

  const outcome = await sendPush(device, pushPayload("test", testMessage()), config);
  console.log(`[notify] type=test recipients=1 sent=${outcome === "sent" ? 1 : 0} ` +
    `failed=${outcome === "failed" ? 1 : 0} pruned=${outcome === "gone" ? 1 : 0}`);

  if (outcome === "gone") {
    await prisma.pushSubscription.deleteMany({ where: { id: device.id } }).catch(() => {});
    return Response.json(
      { error: "This device's subscription has expired. Switch notifications off and on again." },
      { status: 410 }
    );
  }
  if (outcome === "failed") {
    return Response.json({ error: "The push service did not accept the message" }, { status: 502 });
  }
  return Response.json({ ok: true });
}
