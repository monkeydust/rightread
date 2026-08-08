import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { captureUrl } from "@/lib/capture";

/**
 * POST /api/candidates/[id]/save — saves a recommendation into the queue.
 *
 * Goes through the normal capture flow (so the Item gets its own extraction,
 * classification and embedding, exactly as if the user had shared the link),
 * then records savedItemId on the candidate, which permanently removes it
 * from recommendations without deleting the row — deleting it would just let
 * the next feed poll re-admit the same URL.
 */
export async function POST(
  _request: NextRequest,
  ctx: RouteContext<"/api/candidates/[id]/save">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const candidate = await prisma.candidate.findFirst({
    where: { id, userId },
    select: { id: true, url: true },
  });
  if (!candidate) return Response.json({ error: "Not found" }, { status: 404 });

  const { item } = await captureUrl(userId, candidate.url);
  await Promise.all([
    prisma.candidate.update({
      where: { id: candidate.id },
      data: { savedItemId: item.id },
    }),
    // Provenance chip in the list. Set even when the URL was already in the
    // library — the user just chose it *as* a recommendation.
    prisma.item.update({ where: { id: item.id }, data: { recommended: true } }),
  ]);

  return Response.json({ ok: true, itemId: item.id }, { status: 201 });
}
