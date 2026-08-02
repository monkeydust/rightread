import { auth } from "@/auth";
import { captureUrl } from "@/lib/capture";
import { readBearer, userIdFromToken } from "@/lib/tokens";

/**
 * POST /api/capture  { "url": "https://…" }
 *
 * Two callers, two auth modes:
 *  - extension / Shortcut / curl → Authorization: Bearer <capture token>
 *  - the web app itself          → Auth.js session cookie
 *
 * Token auth is allowed from any origin (a bearer token is not sent
 * automatically by a browser, so there is nothing to forge). Cookie auth is
 * restricted to same-origin requests, otherwise any page you visited could POST
 * links into your library.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: corsHeaders });
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser client, no cookies in play
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function resolveUser(request: Request): Promise<string | null> {
  const token = readBearer(request);
  if (token) return userIdFromToken(token);

  if (!isSameOrigin(request)) return null;
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function POST(request: Request) {
  const userId = await resolveUser(request);
  if (!userId) {
    return json({ error: "Unauthorized" }, 401);
  }

  let url: unknown;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      ({ url } = await request.json());
    } else {
      const form = await request.formData();
      url = form.get("url") ?? form.get("text");
    }
  } catch {
    return json({ error: "Malformed request body" }, 400);
  }

  if (typeof url !== "string" || !url.trim()) {
    return json({ error: "Missing 'url'" }, 400);
  }

  try {
    const { item, alreadySaved } = await captureUrl(userId, url);
    return json(
      {
        ok: true,
        alreadySaved,
        item: { id: item.id, url: item.url, title: item.title },
      },
      alreadySaved ? 200 : 201
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save link";
    return json({ error: message }, 400);
  }
}
