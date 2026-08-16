import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { listGroupsFor } from "@/lib/groups/access";
import { createGroup } from "@/lib/groups/manage";
import { groupErrorResponse } from "@/lib/groups/http";

export const dynamic = "force-dynamic";

/** GET /api/groups — the groups I'm in, with member and shelf counts. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return Response.json({ groups: await listGroupsFor(userId) });
}

/** POST /api/groups — creates a group with me as its first member. */
export async function POST(request: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));

  try {
    const group = await createGroup(userId, String(body?.name ?? ""));
    return Response.json({ group }, { status: 201 });
  } catch (err) {
    const response = groupErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
