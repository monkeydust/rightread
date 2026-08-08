import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { normalizeUrl } from "@/lib/url";
import { refreshSource } from "@/lib/sources/refresh";

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

  let feedUrl: string;
  try {
    const body = await request.json();
    feedUrl = normalizeUrl(String(body.feedUrl ?? ""));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Malformed body";
    return Response.json({ error: message }, { status: 400 });
  }

  const existing = await prisma.source.findUnique({
    where: { userId_feedUrl: { userId, feedUrl } },
  });
  if (existing) {
    return Response.json({ error: "Already added" }, { status: 409 });
  }

  const source = await prisma.source.create({
    data: { userId, feedUrl },
    select: { id: true, feedUrl: true },
  });

  // First poll runs detached, like extraction after capture: the row appears
  // instantly, the title and candidates fill in over the next minute or two.
  void refreshSource(source.id);

  return Response.json({ ok: true, source }, { status: 201 });
}
