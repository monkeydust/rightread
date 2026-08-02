import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { moveItem, setStarred } from "@/lib/reorder";
import { isKind } from "@/lib/classify";
import { runExtraction } from "@/lib/capture";

/**
 * PATCH /api/items/[id] — the one mutation endpoint the list UI uses.
 * Body is one of:
 *   { move: "up" | "down" | "top" | "bottom" }
 *   { starred: boolean }
 *   { kind: "conversation" | "article" | "blog" | "reference" | "other" }
 *   { status: "unread" | "archived" }
 *   { progress: 0..1 }
 *   { retry: true }
 */
export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/items/[id]">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const owned = await prisma.item.findFirst({
    where: { id, userId },
    select: { id: true, url: true },
  });
  if (!owned) return Response.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  try {
    if (typeof body.move === "string") {
      if (!["up", "down", "top", "bottom"].includes(body.move)) {
        return Response.json({ error: "Invalid move" }, { status: 400 });
      }
      const moved = await moveItem(userId, id, body.move as "up");
      return Response.json({ ok: true, moved });
    }

    if (typeof body.kind === "string") {
      if (!isKind(body.kind)) {
        return Response.json({ error: "Invalid kind" }, { status: 400 });
      }
      // A manual override is final: kindSource "user" stops re-classification
      // from ever running again for this item.
      await prisma.item.update({
        where: { id },
        data: {
          kind: body.kind,
          kindSource: "user",
          kindConfidence: 1,
          kindReason: "set by you",
        },
      });
      return Response.json({ ok: true });
    }

    if (typeof body.starred === "boolean") {
      await setStarred(userId, id, body.starred);
      return Response.json({ ok: true });
    }

    if (typeof body.status === "string") {
      if (!["unread", "archived"].includes(body.status)) {
        return Response.json({ error: "Invalid status" }, { status: 400 });
      }
      await prisma.item.update({
        where: { id },
        data: {
          status: body.status,
          readAt: body.status === "archived" ? new Date() : null,
        },
      });
      return Response.json({ ok: true });
    }

    if (typeof body.progress === "number") {
      const progress = Math.min(1, Math.max(0, body.progress));
      await prisma.item.update({ where: { id }, data: { progress } });
      return Response.json({ ok: true });
    }

    if (body.retry === true) {
      await prisma.item.update({
        where: { id },
        data: { extractStatus: "pending", extractError: null },
      });
      void runExtraction(id, owned.url);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Nothing to update" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext<"/api/items/[id]">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const { count } = await prisma.item.deleteMany({ where: { id, userId } });
  if (!count) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ ok: true });
}
