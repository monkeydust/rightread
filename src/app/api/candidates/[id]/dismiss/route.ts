import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/candidates/[id]/dismiss — "not interested".
 *
 * Marks the candidate, not the recommendation that surfaced it. The same
 * article can be found by several phrases, and dismissing it under one must
 * not leave another free to bring it straight back.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/candidates/[id]/dismiss">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const candidate = await prisma.candidate.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!candidate || candidate.userId !== userId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.candidate.update({
    where: { id },
    data: { dismissedAt: new Date() },
  });

  return Response.json({ ok: true });
}
