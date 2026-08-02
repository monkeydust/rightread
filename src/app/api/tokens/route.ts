import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { generateToken, hashToken } from "@/lib/tokens";

/** POST /api/tokens { name } — issues a capture token, shown once. */
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let name = "Untitled device";
  try {
    const body = await request.json();
    if (typeof body.name === "string" && body.name.trim()) {
      name = body.name.trim().slice(0, 60);
    }
  } catch {
    // Body is optional.
  }

  const token = generateToken();
  await prisma.captureToken.create({
    data: { userId, name, tokenHash: hashToken(token) },
  });

  // The only time the plaintext ever leaves the server.
  return Response.json({ ok: true, token, name }, { status: 201 });
}

export async function DELETE(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const { count } = await prisma.captureToken.deleteMany({ where: { id, userId } });
  if (!count) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ ok: true });
}
