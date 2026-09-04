/**
 * Cross-user boundary harness. Two users, one scratch DB, every library-level
 * ownership/membership check attacked from the wrong account.
 */
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { execSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const ROOT = process.cwd();
const DB = ROOT + "/prisma/idor-test.db";
for (const f of [DB, DB + "-journal"]) { try { if (existsSync(f)) rmSync(f); } catch {} }
process.env.DATABASE_URL = "file:" + DB;
execSync("npx prisma db push --skip-generate --accept-data-loss", { stdio: "pipe", cwd: ROOT, env: process.env });

const prisma = new PrismaClient();
let failed = 0;
const check = (name: string, ok: boolean, d = "") => {
  if (!ok) { failed++; console.log("FAIL  " + name + (d ? " :: " + d : "")); }
  else console.log("PASS  " + name);
};

const alice = await prisma.user.create({ data: { email: "alice@test" } });
const bob = await prisma.user.create({ data: { email: "bob@test" } });
const aliceItem = await prisma.item.create({ data: { userId: alice.id, url: "https://a.com/x", title: "Alice secret", contentHtml: "<p>secret</p>", extractStatus: "ok" } });
const bobItem = await prisma.item.create({ data: { userId: bob.id, url: "https://b.com/y", title: "Bob secret", extractStatus: "ok" } });

const items = await import("../src/lib/items.ts");
check("getItem: owner sees own item", (await items.getItem(alice.id, aliceItem.id))?.id === aliceItem.id);
check("getItem: cannot read another user's item", (await items.getItem(bob.id, aliceItem.id)) === null, "BOB READ ALICE ITEM");
check("listItems: only own items", (await items.listItems(alice.id, "unread")).every((i) => i.id !== bobItem.id));

const reorder = await import("../src/lib/reorder.ts");
await reorder.moveItem(bob.id, aliceItem.id, "top").catch(() => {});
check("moveItem: cannot reorder another user's item", (await prisma.item.findUnique({ where: { id: aliceItem.id } }))!.position === aliceItem.position, "position changed");
await reorder.setStarred(bob.id, aliceItem.id, true);
check("setStarred: cannot star another user's item", (await prisma.item.findUnique({ where: { id: aliceItem.id } }))!.starred === false, "BOB STARRED ALICE ITEM");

const manage = await import("../src/lib/groups/manage.ts");
const access = await import("../src/lib/groups/access.ts");
const shareMod = await import("../src/lib/groups/share.ts");
const NotAMember = access.NotAMember;

const group = await manage.createGroup(alice.id, "Alice club");
check("createGroup: creator is a member", await access.isMember(alice.id, group.id));
check("createGroup: outsider is not a member", !(await access.isMember(bob.id, group.id)));

const refuse = async (fn: () => Promise<unknown>) => {
  try { await fn(); return false; } catch (e) { return e instanceof NotAMember; }
};

check("listShelf: outsider refused", await refuse(() => access.listShelf(bob.id, group.id)), "BOB READ ALICE SHELF");
check("listPeople: outsider cannot enumerate members", await refuse(() => access.listPeople(bob.id, group.id)), "BOB READ MEMBER EMAILS");
check("shareIntoGroup: outsider cannot post", await refuse(() => shareMod.shareIntoGroup(bob.id, group.id, "https://evil.com/x")), "BOB POSTED TO ALICE SHELF");
check("inviteToGroup: outsider cannot invite", await refuse(() => manage.inviteToGroup(bob.id, group.id, "mallory@test")), "BOB INVITED TO ALICE GROUP");

const share = await shareMod.shareIntoGroup(alice.id, group.id, "https://a.com/x");
check("resolveShare: outsider cannot resolve a share id (IDOR)", await refuse(() => access.resolveShare(bob.id, share.id)), "BOB RESOLVED ALICE SHARE");
check("saveShare: outsider cannot save another group's share", await refuse(() => shareMod.saveShare(bob.id, share.id)), "BOB SAVED ALICE SHARE");
check("dismissShare: outsider cannot dismiss", await refuse(() => shareMod.dismissShare(bob.id, share.id)));
// unshare refuses an outsider by throwing NotAMember (not by returning null);
// either shape is a refusal, and the share must survive.
const outsiderUnshare = await shareMod.unshare(bob.id, share.id).catch((e) => (e instanceof NotAMember ? "refused" : "threw-other"));
check("unshare: outsider cannot remove a share", outsiderUnshare === null || outsiderUnshare === "refused", "BOB UNSHARED ALICE SHARE: " + outsiderUnshare);
check("unshare: share still present", (await prisma.groupShare.count({ where: { id: share.id } })) === 1);

await manage.inviteToGroup(alice.id, group.id, "bob@test");
check("invite made bob a member", await access.isMember(bob.id, group.id));
check("member sees the shelf now", (await access.listShelf(bob.id, group.id)).length >= 1);
check("unshare: a member cannot remove another member's share", (await shareMod.unshare(bob.id, share.id)) === null, "BOB UNSHARED AS MEMBER");

const endings = await import("../src/lib/sources/endings.ts");
const e = await endings.articleEndings(bob.id, aliceItem.id);
check("articleEndings: another user's item yields nothing", e.closest.length === 0 && !e.step && !e.leap && !e.backlog && !e.trailReady, "endings leaked across user");
const trail = await import("../src/lib/trail/walk.ts");
check("buildTrail: cannot start on another user's item", (await trail.buildTrail(bob.id, aliceItem.id)) === null, "trail crossed user");

const tokens = await import("../src/lib/tokens.ts");
check("token: garbage resolves to nobody", (await tokens.userIdFromToken("wrong")) === null);

// Summaries: history is read by owner, and a refresh on someone else's item
// is refused before it fetches or bills anything.
const store = await import("../src/lib/summarize/store.ts");
await store.saveSummary({
  userId: alice.id, itemId: aliceItem.id, kind: "conversation", tldr: "alice's private summary",
  points: [], standout: [], links: [], verdict: "", sinceLast: null, sourceKind: "page",
  fetchedAt: new Date(), commentCount: null, newComments: null, textChars: 10, model: "test", costUsd: null, durationMs: 1,
});
check("listSummaries: owner sees own history", (await store.listSummaries(alice.id, aliceItem.id)).length === 1);
check("listSummaries: another user sees nothing", (await store.listSummaries(bob.id, aliceItem.id)).length === 0, "BOB READ ALICE SUMMARY");
const refresh = await import("../src/lib/summarize/refresh.ts");
const refused = await refresh.refreshSummary(bob.id, aliceItem.id).then(() => false, (e) => e instanceof refresh.NotFoundError);
check("refreshSummary: another user's item is Not Found", refused, "BOB REFRESHED ALICE SUMMARY");
check("refreshSummary: nothing was written", (await prisma.itemSummary.count({ where: { itemId: aliceItem.id } })) === 1);

await prisma.$disconnect();
for (const f of [DB, DB + "-journal"]) { try { if (existsSync(f)) rmSync(f); } catch {} }
console.log(failed === 0 ? "\nAll IDOR checks pass." : "\n" + failed + " FAILING — data boundary hole");
process.exit(failed === 0 ? 0 : 1);
