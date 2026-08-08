import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listItems, countByStatus } from "@/lib/items";
import { countDiscover } from "@/lib/recommendations";
import { AppShell } from "@/components/AppShell";
import { Library } from "@/components/Library";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [items, counts, discoverCount] = await Promise.all([
    listItems(session.user.id, "unread"),
    countByStatus(session.user.id),
    countDiscover(session.user.id),
  ]);

  return (
    <AppShell active="queue" counts={counts} discoverCount={discoverCount}>
      <Library key="unread" initialItems={items} status="unread" />
    </AppShell>
  );
}
