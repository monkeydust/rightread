import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/AppShell";
import { GroupList } from "@/components/GroupList";
import { countByStatus } from "@/lib/items";
import { listGroupsFor } from "@/lib/groups/access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Groups — rightread" };

export default async function GroupsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [groups, counts] = await Promise.all([
    listGroupsFor(session.user.id),
    countByStatus(session.user.id),
  ]);
  const groupCount = groups.reduce((sum, g) => sum + g.shelfCount, 0);

  return (
    <AppShell active="groups" counts={counts} groupCount={groupCount}>
      <div className="px-3 pt-4 sm:px-4">
        <h1 className="text-xl font-semibold tracking-tight">Groups</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
          A shelf you share with a few people. Anything put on it stays there
          until you save it to your own queue or dismiss it.
        </p>
      </div>
      <GroupList groups={groups} />
    </AppShell>
  );
}
