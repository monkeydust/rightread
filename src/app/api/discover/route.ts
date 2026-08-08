import { auth } from "@/auth";
import { getDiscover } from "@/lib/recommendations";

export const dynamic = "force-dynamic";

/** GET /api/discover — recommendations grouped by what produced them. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return Response.json(await getDiscover(userId));
  } catch (err) {
    console.error("[discover] failed:", err);
    return Response.json({ error: "Could not load recommendations" }, { status: 500 });
  }
}
