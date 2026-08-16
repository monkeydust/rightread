import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { dismissShare, undismissShare, unshare } from "@/lib/groups/share";
import { groupErrorResponse } from "@/lib/groups/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/shares/[id]/dismiss — hide a share from my own shelf.
 *
 * `?undo=1` puts it back. `?unshare=1` removes it from the shelf for everyone,
 * and is refused unless I am the person who shared it: dismissal is the power
 * every member has, and one member deleting another's link would be a role in
 * a feature that deliberately has none.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/shares/[id]/dismiss">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const params = new URL(request.url).searchParams;

  try {
    if (params.get("unshare") === "1") {
      const removed = await unshare(userId, id);
      if (!removed) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ ok: true, unshared: true });
    }

    if (params.get("undo") === "1") {
      await undismissShare(userId, id);
      return Response.json({ ok: true, dismissed: false });
    }

    await dismissShare(userId, id);
    return Response.json({ ok: true, dismissed: true });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
