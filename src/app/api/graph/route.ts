import { auth } from "@/auth";
import { buildGraph, clampK } from "@/lib/graph/build";

/**
 * GET /api/graph?status=all|unread|archived&k=4
 *
 * Nodes are saved items, edges are semantic similarity between them. No new
 * API calls — this is arithmetic over embeddings that already exist.
 */
export const dynamic = "force-dynamic";

const STATUSES = ["all", "unread", "archived"] as const;
type Status = (typeof STATUSES)[number];

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const raw = params.get("status");
  // An unrecognised status falls back rather than erroring: this is a view
  // parameter from our own UI, not user data worth rejecting a request over.
  const status: Status = STATUSES.includes(raw as Status) ? (raw as Status) : "all";
  const k = clampK(params.get("k"));

  try {
    const graph = await buildGraph(userId, { status, k });
    return Response.json(graph);
  } catch (err) {
    console.error("[graph] failed:", err);
    return Response.json({ error: "Could not build the graph" }, { status: 500 });
  }
}
