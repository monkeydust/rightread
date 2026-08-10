import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { applyProvidedContent } from "@/lib/capture";

/**
 * POST /api/items/[id]/content  { html }
 *
 * The browser-sourced extraction path. The user's own browser supplies the
 * HTML of a page the server could not fetch — paywalled, or behind a bot check
 * they passed in their session — and the server extracts from that instead.
 *
 * Session auth only, not the capture token: this attaches content to an item
 * the signed-in user owns, from the app itself, so it should carry the session
 * cookie like every other list mutation.
 */
export const dynamic = "force-dynamic";

/**
 * A generous ceiling. A rendered article's HTML is a few hundred KB; this
 * admits even a heavy page while refusing a paste that is really a whole site.
 * Sized in characters because that is what we measure before jsdom parses it.
 */
const MAX_HTML_CHARS = 5_000_000;

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/items/[id]/content">
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const owned = await prisma.item.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!owned || owned.userId !== userId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  let html: string;
  try {
    const body = await request.json();
    html = String(body.html ?? "");
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  if (!html.trim()) {
    return Response.json({ error: "Nothing to extract" }, { status: 400 });
  }
  if (html.length > MAX_HTML_CHARS) {
    return Response.json(
      { error: "That page is too large to accept" },
      { status: 413 }
    );
  }

  try {
    await applyProvidedContent(id, html);
    return Response.json({ ok: true });
  } catch (err) {
    // The common case is a selection that held no readable article — say so,
    // rather than a generic failure, so the user knows to reselect.
    const message =
      err instanceof Error ? err.message : "Could not read that page";
    return Response.json({ error: message }, { status: 422 });
  }
}
