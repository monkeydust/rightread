import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { captureUrl } from "@/lib/capture";
import { extractFirstUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

/**
 * PWA share target (see public/manifest.webmanifest).
 *
 * Android hands over {title, text, url}, but which field holds the link varies
 * by app — plenty of them put the URL inside `text`, sometimes with surrounding
 * words. So we take `url` when present and otherwise pull the first http(s)
 * token out of `text`.
 */
function pickUrl(params: Record<string, string | undefined>): string | null {
  // `url` first when the sharing app populated it properly, then fall back to
  // digging a link out of `text`. Both go through the same extractor the paste
  // box uses, so a share and a paste of the same string behave identically.
  return (
    extractFirstUrl(params.url ?? "") ?? extractFirstUrl(params.text ?? "")
  );
}

export default async function SharePage(props: PageProps<"/share">) {
  const searchParams = await props.searchParams;
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(searchParams)) {
    flat[key] = Array.isArray(value) ? value[0] : value;
  }

  const session = await auth();
  if (!session?.user?.id) {
    // Preserve the shared link through the sign-in round trip.
    const back = new URLSearchParams(
      Object.entries(flat).filter(([, v]) => v) as [string, string][]
    );
    redirect(`/login?callbackUrl=${encodeURIComponent(`/share?${back}`)}`);
  }

  const url = pickUrl(flat);

  let state: { ok: true; alreadySaved: boolean; title: string } | { ok: false; error: string };
  if (!url) {
    state = { ok: false, error: "That share didn't contain a link." };
  } else {
    try {
      const { item, alreadySaved } = await captureUrl(session.user.id, url);
      state = { ok: true, alreadySaved, title: item.title };
    } catch (err) {
      state = {
        ok: false,
        error: err instanceof Error ? err.message : "Could not save that link.",
      };
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 text-center">
      {state.ok ? (
        <>
          <div className="text-4xl" aria-hidden>
            ✓
          </div>
          <h1 className="mt-3 text-lg font-semibold">
            {state.alreadySaved ? "Already saved" : "Saved to rightread"}
          </h1>
          <p
            className="mt-1 line-clamp-2 text-sm"
            style={{ color: "var(--text-muted)" }}
          >
            {state.title}
          </p>
        </>
      ) : (
        <>
          <div className="text-4xl" aria-hidden>
            ✕
          </div>
          <h1 className="mt-3 text-lg font-semibold">Couldn&apos;t save that</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {state.error}
          </p>
        </>
      )}

      <Link
        href="/"
        className="mt-8 rounded-lg px-4 py-2.5 text-sm font-medium"
        style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
      >
        Open queue
      </Link>
    </main>
  );
}
