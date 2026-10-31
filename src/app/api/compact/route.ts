import { auth } from "@/auth";
import { compact, previewCompaction, NothingToCompactError } from "@/lib/compact";

/** GET /api/compact — what a compaction would archive right now. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { cutoff, items, starredKept } = await previewCompaction(userId);
  return Response.json({ cutoff, count: items.length, starredKept });
}

/**
 * POST /api/compact — archive the backlog and create the digest. Returns as
 * soon as both are stored; the essay is written in the background.
 */
export async function POST() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { digestId, archived } = await compact(userId);
    return Response.json({ ok: true, digestId, archived }, { status: 201 });
  } catch (err) {
    if (err instanceof NothingToCompactError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    console.error(`[compact] failed: ${err instanceof Error ? err.message : err}`);
    return Response.json({ error: "Compact failed; nothing was archived." }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
