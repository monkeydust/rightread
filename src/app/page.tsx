import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listItems, countByStatus } from "@/lib/items";
import { AppShell } from "@/components/AppShell";
import { Library } from "@/components/Library";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [items, counts] = await Promise.all([
    listItems(session.user.id, "unread"),
    countByStatus(session.user.id),
  ]);

  return (
    <AppShell active="queue" counts={counts}>
      <Library key="unread" initialItems={items} status="unread" />
    </AppShell>
  );
}
