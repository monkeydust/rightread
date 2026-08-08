import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { embedPhrase, matchAllPhrases } from "@/lib/phrases/match";

/** GET /api/phrases — the user's standing queries. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const phrases = await prisma.keyPhrase.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      text: true,
      active: true,
      embeddedAt: true,
      lastMatchedAt: true,
    },
  });
  return Response.json({ phrases });
}

/** POST /api/phrases { text } */
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let text: string;
  try {
    const body = await request.json();
    text = String(body.text ?? "").trim();
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }

  if (!text) return Response.json({ error: "Enter a phrase" }, { status: 400 });
  // Long enough to be a topic, short enough to stay a query. A whole paragraph
  // pasted in here would be a document, which is a different distribution and
  // would score against the wrong floor.
  if (text.length > 200) {
    return Response.json(
      { error: "Keep it under 200 characters — a phrase, not a paragraph" },
      { status: 400 }
    );
  }

  const existing = await prisma.keyPhrase.findUnique({
    where: { userId_text: { userId, text } },
  });
  if (existing) return Response.json({ error: "Already added" }, { status: 409 });

  const phrase = await prisma.keyPhrase.create({
    data: { userId, text },
    select: { id: true, text: true },
  });

  // Embed and match detached, like the first poll after adding a source: the
  // row appears immediately and results fill in over the next few seconds.
  void (async () => {
    await embedPhrase(phrase.id);
    await matchAllPhrases();
  })();

  return Response.json({ ok: true, phrase }, { status: 201 });
}
