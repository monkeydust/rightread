import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { LLMUnavailableError } from "@/lib/openrouter";
import { NotSummarisableError } from "@/lib/summarize";
import {
  refreshSummary,
  NotFoundError,
  ThreadFetchError,
} from "@/lib/summarize/refresh";
import type { StoredSummary } from "@/lib/summarize/store";

/**
 * POST /api/items/[id]/summary
 *
 * Re-fetches the page (a thread, where the site allows it), stores the fresh
 * copy, summarises it against the previous summary, and appends the result to
 * the item's summary history. Returns the new row.
 *
 * Session auth only. Online-only by nature — the caller needs the answer, so
 * this is not an outbox operation. Errors carry a message meant for the
 * reader's eyes: they pressed a button, and "something went wrong" is the one
 * answer that is never acceptable here.
 */
export const dynamic = "force-dynamic";

/**
 * One generation per item at a time. A double-tap, or two tabs, would
 * otherwise fetch and bill twice and write two rows a second apart with
 * nothing between them. The second caller waits on the first's promise and
 * gets the same row back.
 */
const inFlight = new Map<string, Promise<StoredSummary>>();

/**
 * GET: is a summary being generated for this item right now, and which is the
 * newest one stored? The reader asks on every open of a conversation page, so
 * a summary started before you tapped away — or before the app was closed —
 * is still shown as in progress when you come back, and a page rendered from
 * a cached copy can tell that it is behind. Cheap: the in-flight map is
 * in-memory and the newest-id lookup is one indexed row, scoped by owner.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/items/[id]/summary">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const latest = await prisma.itemSummary.findFirst({
    where: { userId, itemId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return Response.json({
    running: inFlight.has(`${userId}:${id}`),
    latestId: latest?.id ?? null,
  });
}

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/items/[id]/summary">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const key = `${userId}:${id}`;

  let work = inFlight.get(key);
  if (!work) {
    work = refreshSummary(userId, id).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
  }

  try {
    const summary = await work;
    return Response.json({ summary });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (err instanceof NotSummarisableError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof ThreadFetchError) {
      return Response.json(
        { error: `Couldn't fetch the thread: ${err.message}` },
        { status: 502 }
      );
    }
    if (err instanceof LLMUnavailableError) {
      return Response.json(
        { error: "The summariser is unavailable right now. Try again in a minute." },
        { status: 503 }
      );
    }
    console.error(`[rightread] summary failed for item ${id}:`, err);
    return Response.json({ error: "Couldn't summarise this page" }, { status: 500 });
  }
}
