import { auth } from "@/auth";
import { subscribe, type AppEvent } from "@/lib/events";

/**
 * GET /api/events — Server-Sent Events stream for the signed-in user.
 *
 * Replaces polling for background completions. Extraction and classification
 * finish seconds after the capture request returns; this pushes the moment
 * they do, rather than the client checking every two seconds and stopping at
 * the wrong time.
 *
 * EventSource cannot set headers, so this authenticates on the session cookie
 * like any other same-origin request.
 */

// Long-lived response: never prerender, never cache.
export const dynamic = "force-dynamic";

/**
 * Comment lines every 25s. Two reasons: idle connections get reaped by proxies
 * and phone radios, and a write is the only way to notice the client has gone
 * — the abort signal is not always delivered.
 */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Client vanished mid-write; tear down rather than retry.
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // `retry` tells EventSource how long to wait before reconnecting. The
      // browser reconnects on its own, so a dropped connection is self-healing.
      send("retry: 3000\n\n");
      send(": connected\n\n");

      // The event's own `type` is the SSE event name, so a client can listen
      // for just the one it cares about — the shelf does not need to refetch
      // because an extraction finished, and the queue does not need to refetch
      // because someone shared into a group.
      unsubscribe = subscribe(userId, (event: AppEvent) => {
        send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // `no-transform` matters as much as `no-cache`: without it a proxy may
      // buffer the stream and nothing arrives until the connection closes.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tells nginx-family proxies not to buffer. Caddy doesn't buffer
      // streaming responses, but this costs nothing and survives a proxy swap.
      "X-Accel-Buffering": "no",
    },
  });
}
