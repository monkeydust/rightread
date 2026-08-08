import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { refreshSource } from "@/lib/sources/refresh";
import { discoverFeed } from "@/lib/sources/discover";

/** GET /api/sources — the user's curated feed list, with pool counts. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const sources = await prisma.source.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      feedUrl: true,
      title: true,
      siteUrl: true,
      active: true,
      lastFetchedAt: true,
      lastError: true,
      _count: { select: { candidates: true } },
    },
  });

  return Response.json({ sources });
}

/** POST /api/sources { feedUrl } — add a feed and poll it right away. */
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Whatever was pasted — a site, a bare hostname, or the feed itself.
  let input: string;
  try {
    const body = await request.json();
    input = String(body.feedUrl ?? "");
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  // Resolved before the row is created, unlike the old flow which stored the
  // URL first and discovered it was unusable on the detached first poll. That
  // put the error on a row the user then had to delete; now a site with no
  // feed simply never becomes a source.
  let feedUrl: string;
  let title: string | null = null;
  let siteUrl: string | null = null;
  let via: string;
  try {
    const found = await discoverFeed(input);
    feedUrl = found.feedUrl;
    title = found.feed.title ?? null;
    siteUrl = found.feed.siteUrl ?? null;
    via = found.via;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not find a feed";
    return Response.json({ error: message }, { status: 400 });
  }

  const existing = await prisma.source.findUnique({
    where: { userId_feedUrl: { userId, feedUrl } },
  });
  if (existing) {
    return Response.json({ error: "Already added" }, { status: 409 });
  }

  const source = await prisma.source.create({
    // Title and site are already known from the discovery fetch, so the row is
    // named the moment it appears rather than after the first poll lands.
    data: { userId, feedUrl, title, siteUrl },
    select: { id: true, feedUrl: true, title: true },
  });

  // First poll runs detached, like extraction after capture: the row appears
  // instantly, the title and candidates fill in over the next minute or two.
  void refreshSource(source.id);

  return Response.json({ ok: true, source, via }, { status: 201 });
}
