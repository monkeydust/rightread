import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/AppShell";
import { GroupShelf } from "@/components/GroupShelf";
import { GroupPeople } from "@/components/GroupPeople";
import { countByStatus } from "@/lib/items";
import { listShelf, listPeople, NotAMember } from "@/lib/groups/access";
import { isEmailAllowed } from "@/lib/allowlist";

export const dynamic = "force-dynamic";

export default async function GroupPage(ctx: PageProps<"/groups/[id]">) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const { id } = await ctx.params;

  // Every one of these throws NotAMember for a stranger, which becomes a 404 —
  // the same answer they would get for a group that does not exist. Confirming
  // that an id is real is precisely what an enumeration attempt wants.
  let shelf, people, group;
  try {
    [shelf, people, group] = await Promise.all([
      listShelf(userId, id),
      listPeople(userId, id),
      prisma.group.findUnique({ where: { id }, select: { name: true } }),
    ]);
  } catch (err) {
    if (err instanceof NotAMember) notFound();
    throw err;
  }
  if (!group) notFound();

  // Computed at render, never stored, so correcting the env var on the server
  // fixes every stale "cannot sign in yet" warning at once.
  const invites = people.invites.map((invite) => ({
    ...invite,
    canSignIn: isEmailAllowed(invite.email),
  }));

  const counts = await countByStatus(userId);

  return (
    <AppShell active="groups" counts={counts}>
      <GroupShelf
        groupId={id}
        groupName={group.name}
        initialShares={shelf}
      />
      <GroupPeople
        groupId={id}
        groupName={group.name}
        members={people.members}
        invites={invites}
      />
    </AppShell>
  );
}
