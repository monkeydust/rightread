import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { listShelf } from "@/lib/groups/access";
import { shareIntoGroup } from "@/lib/groups/share";
import { groupErrorResponse } from "@/lib/groups/http";

export const dynamic = "force-dynamic";

/** GET /api/groups/[id]/shares — the shelf as I see it, minus what I've dismissed. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/groups/[id]/shares">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  try {
    return Response.json({ shares: await listShelf(userId, id) });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}

/** POST /api/groups/[id]/shares — put a link on the shelf. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/groups/[id]/shares">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const url = String(body?.url ?? "").trim();
  if (!url) return Response.json({ error: "A link is required" }, { status: 400 });

  try {
    const share = await shareIntoGroup(userId, id, url, body?.note ?? null);
    return Response.json({ share }, { status: 201 });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    // normalizeUrl throws on something that isn't a link. Same shape the paste
    // box already gets from /api/items.
    const message = err instanceof Error ? err.message : "Could not share that link";
    return Response.json({ error: message }, { status: 400 });
  }
}
