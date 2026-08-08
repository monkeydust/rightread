import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listItems, countByStatus } from "@/lib/items";
import { countDiscover } from "@/lib/recommendations";
import { AppShell } from "@/components/AppShell";
import { Library } from "@/components/Library";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [items, counts, discoverCount] = await Promise.all([
    listItems(session.user.id, "archived"),
    countByStatus(session.user.id),
    countDiscover(session.user.id),
  ]);

  return (
    <AppShell active="archive" counts={counts} discoverCount={discoverCount}>
      <Library key="archived" initialItems={items} status="archived" />
    </AppShell>
  );
}
