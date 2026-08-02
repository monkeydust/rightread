import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/items/[id]/progress  { progress: 0..1 }
 *
 * Split out from PATCH /api/items/[id] because the reader saves progress with
 * navigator.sendBeacon on pagehide, and sendBeacon can only issue POST.
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/items/[id]/progress">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return new Response(null, { status: 401 });

  const { id } = await ctx.params;

  let progress: unknown;
  try {
    ({ progress } = await request.json());
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof progress !== "number" || Number.isNaN(progress)) {
    return new Response(null, { status: 400 });
  }

  await prisma.item.updateMany({
    where: { id, userId },
    data: { progress: Math.min(1, Math.max(0, progress)) },
  });

  // sendBeacon ignores the body; 204 keeps it cheap.
  return new Response(null, { status: 204 });
}
