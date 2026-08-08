import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { countByStatus } from "@/lib/items";
import { getDiscover } from "@/lib/recommendations";
import { AppShell } from "@/components/AppShell";
import { DiscoverFeed } from "@/components/DiscoverFeed";

export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [counts, data] = await Promise.all([
    countByStatus(session.user.id),
    getDiscover(session.user.id),
  ]);

  return (
    <AppShell active="discover" counts={counts} discoverCount={data.total}>
      <div className="px-3 pt-4 sm:px-4">
        <h1 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
          Discover
        </h1>
        <p className="mt-1 max-w-2xl text-[13px]" style={{ color: "var(--text-muted)" }}>
          Brought in by your key phrases and by what you have already saved.
          Nothing here is in your queue until you put it there.
        </p>
      </div>
      <DiscoverFeed data={data} />
    </AppShell>
  );
}
