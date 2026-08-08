import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { similarCandidates } from "@/lib/sources/similar";

/**
 * GET /api/items/[id]/similar — candidates from the user's curated sources,
 * ranked by embedding similarity to this item. Ownership is checked inside
 * similarCandidates (an unowned id returns empty, indistinguishable from
 * "no candidates" — nothing to enumerate).
 */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/items/[id]/similar">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const result = await similarCandidates(userId, id);
  return Response.json(result);
}
