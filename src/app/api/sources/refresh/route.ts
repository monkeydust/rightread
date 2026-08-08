import { auth } from "@/auth";
import { refreshAllSources } from "@/lib/sources/refresh";

/**
 * POST /api/sources/refresh — manual poll, fire-and-forget.
 *
 * Returns 202 immediately: a sweep can take minutes (serial fetch + extract
 * per new article), far past what a request should hold open. Progress shows
 * up as lastFetchedAt / candidate counts on the sources list. If a sweep is
 * already running, refreshAllSources() is a no-op — also fine.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  void refreshAllSources();
  return Response.json({ ok: true, started: true }, { status: 202 });
}
