import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { inviteToGroup, revokeInvite } from "@/lib/groups/manage";
import { groupErrorResponse } from "@/lib/groups/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/groups/[id]/invites — invite an address.
 *
 * The response carries `canSignIn`. When it is false the address is not on
 * `RIGHTREAD_ALLOWED_EMAILS` and cannot sign in yet, so the invite is real but
 * dormant — the UI has to say so rather than implying the person will turn up.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/groups/[id]/invites">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));

  try {
    const result = await inviteToGroup(userId, id, String(body?.email ?? ""));
    return Response.json(result, { status: 201 });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}

/** DELETE /api/groups/[id]/invites?inviteId=… — withdraw a pending invite. */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/groups/[id]/invites">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const inviteId = new URL(request.url).searchParams.get("inviteId");
  if (!inviteId) return Response.json({ error: "inviteId is required" }, { status: 400 });

  try {
    await revokeInvite(userId, id, inviteId);
    return Response.json({ ok: true });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
