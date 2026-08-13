import { auth } from "@/auth";
import { search, searchExact, searchSemantic } from "@/lib/search/search";

/**
 * GET /api/search?q=…&mode=exact|semantic
 *
 * Keyword and semantic results are separate lists — see src/lib/search/search.ts
 * for why — and, with a mode, separate REQUESTS: the client fires both in
 * parallel and renders keyword hits the moment they land (~ms of SQLite)
 * instead of holding them hostage to the embedding network round trip.
 *
 * mode=semantic takes `exclude` (comma-joined item ids, in practice the
 * keyword hits) so a fact is not repeated as a guess. Ids are opaque cuids
 * scoped by userId in every query, so an id someone else owns simply never
 * matches. No mode returns the old combined shape.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  if (q.length > 500) {
    return Response.json({ error: "Query too long" }, { status: 400 });
  }

  const mode = params.get("mode");

  try {
    if (mode === "exact") {
      return Response.json(await searchExact(userId, q));
    }
    if (mode === "semantic") {
      const exclude = (params.get("exclude") ?? "")
        .split(",")
        .filter(Boolean)
        // A tampered list can only shrink someone's own results, but an
        // unbounded one is a free memory lever; EXACT_LIMIT is 50.
        .slice(0, 100);
      return Response.json(await searchSemantic(userId, q, exclude));
    }
    return Response.json(await search(userId, q));
  } catch (err) {
    console.error("[search] failed:", err);
    return Response.json({ error: "Search failed" }, { status: 500 });
  }
}
