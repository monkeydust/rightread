import { auth } from "@/auth";
import { setPreference } from "@/lib/notify/subscriptions";

export const dynamic = "force-dynamic";

/** PUT /api/push/preferences { type, enabled } — one switch in Settings. */
export async function PUT(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const ok = await setPreference(userId, body?.type, body?.enabled);
  if (!ok) return Response.json({ error: "Unknown notification type" }, { status: 400 });
  return Response.json({ ok: true });
}
