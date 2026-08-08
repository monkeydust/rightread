import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/** PATCH /api/sources/[id] { active: boolean } — pause or resume a feed. */
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/sources/[id]">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  if (typeof body.active !== "boolean") {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { count } = await prisma.source.updateMany({
    where: { id, userId },
    data: { active: body.active },
  });
  if (!count) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ ok: true });
}

/**
 * DELETE /api/sources/[id] — removes the feed and (via cascade) its unsaved
 * candidates. Items saved from it are untouched: they belong to the library.
 */
export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext<"/api/sources/[id]">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const { count } = await prisma.source.deleteMany({ where: { id, userId } });
  if (!count) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ ok: true });
}
