import { NextRequest } from "next/server";
import { handlers } from "@/auth";

/**
 * Rebases the request onto the host the user actually typed.
 *
 * Auth.js builds the magic-link callback URL from `new URL(request.url)`, and
 * Next always reports that as the address the server is *bound* to — so a
 * sign-in started from your phone at http://192.168.1.20:3002 produced a link
 * to http://localhost:3002, which is dead on the phone. `AUTH_TRUST_HOST`
 * doesn't help: it only covers the paths that go through `createActionURL`,
 * and the email callback URL isn't one of them.
 *
 * So we rewrite the request URL from the Host header before Auth.js sees it.
 *
 * This is gated on AUTH_TRUST_HOST because it means trusting a client-supplied
 * header: someone could otherwise send `Host: evil.com` and receive a sign-in
 * link pointing at their own domain, leaking the token if it were clicked.
 * Trust it on a LAN or behind a proxy that overwrites the header; set AUTH_URL
 * explicitly for a fixed public domain, which takes precedence and skips this.
 */
async function rebaseOnRequestHost(request: NextRequest): Promise<NextRequest> {
  const trustHost = process.env.AUTH_TRUST_HOST === "true";
  const pinnedUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!trustHost || pinnedUrl) return request;

  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return request;

  const protocol = request.headers.get("x-forwarded-proto") ?? "http";
  const current = new URL(request.url);
  const target = `${protocol}://${host}`;
  if (current.origin === target) return request;

  const url = new URL(current.pathname + current.search, target);

  // Auth.js POST bodies are tiny (a form), so buffering is cheap and avoids
  // the half-duplex handling that cloning a streaming body would need.
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  return new NextRequest(url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

export async function GET(request: NextRequest) {
  return handlers.GET(await rebaseOnRequestHost(request));
}

export async function POST(request: NextRequest) {
  return handlers.POST(await rebaseOnRequestHost(request));
}
