import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { listPeople } from "@/lib/groups/access";
import { removeMember } from "@/lib/groups/manage";
import { groupErrorResponse } from "@/lib/groups/http";

export const dynamic = "force-dynamic";

/** GET /api/groups/[id]/members — members and outstanding invites. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/groups/[id]/members">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  try {
    return Response.json(await listPeople(userId, id));
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}

/**
 * DELETE /api/groups/[id]/members?userId=… — removes someone.
 *
 * Any member may remove any other: the group is flat by design. Removing
 * yourself is routed to `leaveGroup`, which is the operation that knows what to
 * do when you were the last one in.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/groups/[id]/members">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const target = new URL(request.url).searchParams.get("userId");
  if (!target) return Response.json({ error: "userId is required" }, { status: 400 });

  try {
    const { deletedGroup } = await removeMember(userId, id, target);
    return Response.json({ ok: true, deletedGroup });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
