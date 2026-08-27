import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildTrail, TRAIL_STOPS } from "@/lib/trail/walk";
import { readingMinutes } from "@/lib/extract";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trail — rightread" };

/**
 * A walk through your own library, laid out as a path rather than a list.
 *
 * The trail is deterministic (same library, same start, same walk), so this
 * page holds no state: reading a stop and pressing back re-renders the same
 * trail. The computed stop ids are also pinned into ?path=, so the walk even
 * survives the library changing underneath it mid-read. "Walk a different
 * way" bumps ?seed=, which is a new walk and therefore drops the pin.
 */
export default async function TrailPage(props: PageProps<"/trail/[id]">) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const { id } = await props.params;
  const search = await props.searchParams;

  const start = await prisma.item.findFirst({
    where: { id, userId },
    select: { id: true, title: true },
  });
  if (!start) notFound();

  const seedRaw = Array.isArray(search.seed) ? search.seed[0] : search.seed;
  const seed = Math.max(0, Number.parseInt(seedRaw ?? "0", 10) || 0);
  const pathRaw = Array.isArray(search.path) ? search.path[0] : search.path;
  const pinnedPath = pathRaw
    ? pathRaw.split(".").filter((p) => /^[\w-]+$/.test(p))
    : undefined;

  const trail = await buildTrail(userId, id, { seed, pinnedPath });

  // Pin a freshly computed walk into the URL. The walk is deterministic, but
  // the library underneath it is not — save one article mid-trail and a
  // recompute would silently reroute every remaining stop. With the ids in the
  // address, the back button always returns to exactly the trail you were on.
  // One redirect, only when the URL does not already state the rendered walk —
  // absent, stale, or rejected pins all land here. Ids are compared, not
  // lengths: a rejected pin can coincide in length with the fresh walk, and a
  // URL that names stops the page is not showing would be a quiet lie.
  if (trail) {
    const pin = trail.stops.map((s) => s.id).join(".");
    if (pathRaw !== pin) redirect(`/trail/${id}?seed=${seed}&path=${pin}`);
  }

  const muted = { color: "var(--text-muted)" } as const;

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-6">
      <Link
        href={`/read/${start.id}`}
        className="text-[13px] hover:underline"
        style={muted}
      >
        ← Back to the article
      </Link>

      <h1 className="mt-4 text-xl font-semibold tracking-tight">A trail</h1>
      <p className="mt-1 text-[13px]" style={muted}>
        {TRAIL_STOPS} stops through your own library, each a step away from the
        last, drifting away from where you started.
      </p>

      {!trail ? (
        <p className="mt-12 text-sm" style={muted}>
          No trail starts here yet — this article hasn&apos;t been connected to
          the rest of your library. It usually just needs a few more saved
          articles, or a moment for embedding to finish.
        </p>
      ) : (
        <>
          <ol className="mt-8">
            {trail.stops.map((stop, i) => (
              <li key={stop.id} className="relative flex gap-4 pb-8">
                {/* The path line, drawn per row so it ends at the last stop. */}
                {i < trail.stops.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute left-[11px] top-6 h-full w-px"
                    style={{ background: "var(--border)" }}
                  />
                )}
                <span
                  aria-hidden
                  className="relative mt-1.5 grid h-[23px] w-[23px] shrink-0 place-items-center rounded-full border text-[11px] tabular-nums"
                  style={{
                    borderColor: i === 0 ? "var(--accent)" : "var(--border)",
                    color: i === 0 ? "var(--accent)" : "var(--text-muted)",
                    background: "var(--bg)",
                  }}
                >
                  {i === 0 ? "•" : i}
                </span>

                <div className="min-w-0 flex-1">
                  <Link
                    href={`/read/${stop.id}`}
                    className="text-[15px] font-medium leading-snug hover:underline"
                  >
                    {stop.title}
                  </Link>
                  <div
                    className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px]"
                    style={muted}
                  >
                    {stop.siteName && <span>{stop.siteName}</span>}
                    {stop.siteName && stop.wordCount ? (
                      <span aria-hidden>·</span>
                    ) : null}
                    {stop.wordCount ? (
                      <span>{readingMinutes(stop.wordCount)} min</span>
                    ) : null}
                    {i > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">
                          {Math.round(stop.simToPrev * 100)}% like the last stop
                          {" · "}
                          {Math.round(stop.simToStart * 100)}% like where you
                          started
                        </span>
                      </>
                    )}
                  </div>
                  {stop.excerpt && (
                    <p className="mt-1 line-clamp-2 text-[13px]" style={muted}>
                      {stop.excerpt}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {trail.endedEarly && (
            <p className="text-[13px]" style={muted}>
              The trail ends here — your library thins out in this direction.
            </p>
          )}

          <p className="mt-8 text-[13px]">
            <Link
              href={`/trail/${start.id}?seed=${trail.seed + 1}`}
              className="hover:underline"
            >
              Walk a different way →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
