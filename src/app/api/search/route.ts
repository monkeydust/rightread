import { auth } from "@/auth";
import { search } from "@/lib/search/search";

/**
 * GET /api/search?q=…
 *
 * Returns keyword and semantic results as two separate lists rather than one
 * merged ranking — see src/lib/search/search.ts for why.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q.length > 500) {
    return Response.json({ error: "Query too long" }, { status: 400 });
  }

  try {
    const results = await search(userId, q);
    return Response.json(results);
  } catch (err) {
    console.error("[search] failed:", err);
    return Response.json({ error: "Search failed" }, { status: 500 });
  }
}
