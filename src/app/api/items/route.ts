import { auth } from "@/auth";
import { listItems } from "@/lib/items";
import { captureUrl } from "@/lib/capture";

/**
 * GET /api/items?status=unread
 * Used by the list to poll while freshly captured items are still extracting.
 */
export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const status = new URL(request.url).searchParams.get("status") ?? "unread";
  if (!["unread", "archived"].includes(status)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }

  const items = await listItems(userId, status as "unread");
  return Response.json({ items });
}

/** POST /api/items — save a link from the paste box in the app. */
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let url: unknown;
  try {
    ({ url } = await request.json());
  } catch {
    return Response.json({ error: "Malformed body" }, { status: 400 });
  }
  if (typeof url !== "string" || !url.trim()) {
    return Response.json({ error: "Missing 'url'" }, { status: 400 });
  }

  try {
    const { item, alreadySaved } = await captureUrl(userId, url);
    return Response.json({ ok: true, alreadySaved, id: item.id }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save link";
    return Response.json({ error: message }, { status: 400 });
  }
}

export const dynamic = "force-dynamic";
