import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { countByStatus } from "@/lib/items";
import { AppShell } from "@/components/AppShell";
import { SemanticGraph } from "@/components/SemanticGraph";

export const dynamic = "force-dynamic";

export default async function GraphPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const counts = await countByStatus(session.user.id);

  // The graph is deliberately fetched client-side rather than rendered here.
  // It depends on controls that live in the client (k, archived), so building
  // it server-side would only be thrown away on the first interaction — and
  // the page becomes interactive while the layout is still settling.
  return (
    <AppShell active="graph" counts={counts} wide>
      <div className="px-3 pt-4 sm:px-4">
        <h1 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
          How your library connects
        </h1>
        {/* Short on a phone, where four lines of preamble push the graph itself
            off the screen; the full explanation is one tap away in the README. */}
        <p className="mt-1 max-w-2xl text-[13px]" style={{ color: "var(--text-muted)" }}>
          <span className="hidden sm:inline">
            Every page you save is placed near the ones it resembles, using the same
            embeddings that power search. Nothing here was tagged by hand — the
            clusters are whatever your reading actually has in common.
          </span>
          <span className="sm:hidden">
            Pages sit near the ones they resemble. Nothing was tagged by hand.
          </span>
        </p>
      </div>
      <SemanticGraph initial={null} />
    </AppShell>
  );
}
