import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/** GET /api/compact/<digestId> — is the essay still being written? */
export async function GET(_request: Request, ctx: RouteContext<"/api/compact/[id]">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const digest = await prisma.item.findFirst({
    where: { id, userId, digest: true },
    select: { extractStatus: true },
  });
  if (!digest) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ pending: digest.extractStatus === "pending" });
}

export const dynamic = "force-dynamic";
