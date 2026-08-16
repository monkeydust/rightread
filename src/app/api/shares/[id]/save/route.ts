import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { saveShare } from "@/lib/groups/share";
import { groupErrorResponse } from "@/lib/groups/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/shares/[id]/save — copies a shared link into my own library.
 *
 * Runs the ordinary capture flow, so what I end up holding is a normal Item
 * with its own extraction, classification and embedding — not a reference to
 * the sharer's copy. That is what lets ordering, starring, search and the graph
 * stay entirely unaware that groups exist.
 *
 * The share id is resolved through `saveShare`, which checks membership of the
 * group it belongs to. Looking it up by id alone would make this an oracle:
 * enumerate ids and the server would fetch and extract strangers' links for you.
 */
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/shares/[id]/save">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  try {
    const { item, alreadySaved } = await saveShare(userId, id);
    return Response.json({ ok: true, itemId: item.id, alreadySaved }, { status: 201 });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
