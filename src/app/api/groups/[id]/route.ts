import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { renameGroup, leaveGroup } from "@/lib/groups/manage";
import { groupErrorResponse } from "@/lib/groups/http";

export const dynamic = "force-dynamic";

/** PATCH /api/groups/[id] — rename. Any member may. */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/groups/[id]">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));

  try {
    const group = await renameGroup(userId, id, String(body?.name ?? ""));
    return Response.json({ group });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}

/**
 * DELETE /api/groups/[id] — leave.
 *
 * Deletes the group outright when the caller was the last member, since a group
 * nobody is in has no way back into it. The response says which happened so the
 * UI can tell the difference.
 */
export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/groups/[id]">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  try {
    const { deletedGroup } = await leaveGroup(userId, id);
    return Response.json({ ok: true, deletedGroup });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
