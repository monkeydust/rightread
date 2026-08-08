import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { embedPhrase, matchAllPhrases } from "@/lib/phrases/match";

async function owned(userId: string, id: string) {
  const phrase = await prisma.keyPhrase.findUnique({
    where: { id },
    select: { id: true, userId: true, text: true },
  });
  return phrase && phrase.userId === userId ? phrase : null;
}

/** PATCH /api/phrases/[id] { text?, active? } */
export async function PATCH(request: Request, ctx: RouteContext<"/api/phrases/[id]">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const phrase = await owned(userId, id);
  if (!phrase) return Response.json({ error: "Not found" }, { status: 404 });

  let body: { text?: unknown; active?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  const data: { text?: string; active?: boolean } = {};
  if (typeof body.active === "boolean") data.active = body.active;
  if (typeof body.text === "string") {
    const text = body.text.trim();
    if (!text) return Response.json({ error: "Enter a phrase" }, { status: 400 });
    if (text.length > 200) {
      return Response.json({ error: "Keep it under 200 characters" }, { status: 400 });
    }
    data.text = text;
  }
  if (Object.keys(data).length === 0) {
    return Response.json({ error: "Nothing to change" }, { status: 400 });
  }

  await prisma.keyPhrase.update({ where: { id }, data });

  // Changed text means a different query, so the old vector and everything it
  // matched are stale. Re-embedding clears lastMatchedAt, which backfills the
  // new phrase against the whole pool rather than only future arrivals.
  if (data.text && data.text !== phrase.text) {
    await prisma.recommendation.deleteMany({
      where: { userId, originKind: "phrase", originId: id },
    });
    void (async () => {
      await embedPhrase(id);
      await matchAllPhrases();
    })();
  }

  return Response.json({ ok: true });
}

/** DELETE /api/phrases/[id] */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/phrases/[id]">) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!(await owned(userId, id))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Recommendations reference the phrase by a plain id column rather than a
  // foreign key, so nothing cascades — they are removed explicitly.
  await prisma.recommendation.deleteMany({
    where: { userId, originKind: "phrase", originId: id },
  });
  await prisma.keyPhrase.delete({ where: { id } });

  return Response.json({ ok: true });
}
