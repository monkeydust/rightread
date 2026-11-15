/**
 * The live-update registry is one per process, not one per copy of the module.
 *
 * The production build gives pages and API routes their own copies of
 * src/lib/events.ts. The registry used to be a module variable (shared through
 * globalThis only outside production), so a publish made while rendering the
 * /share page reached none of the tabs subscribed through /api/events: a link
 * saved from the Android share sheet never appeared in an open queue.
 *
 * Importing the file under two different query strings gives two module
 * instances, which is the same situation without needing a build.
 */

process.env.NODE_ENV = "production";

type Events = typeof import("../src/lib/events.ts");

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
}

const route = (await import("../src/lib/events.ts?copy=route")) as Events;
const page = (await import("../src/lib/events.ts?copy=page")) as Events;

check("the two imports really are separate module instances", route.publish !== page.publish);

const heard: string[] = [];
const unsubscribe = route.subscribe("u1", (event) => heard.push(`${event.type}:${event.cause}`));

page.publish("u1", { type: "items-changed", cause: "captured", itemId: "i1" });
check("a publish from one copy reaches a listener subscribed through the other", heard.join() === "items-changed:captured", heard.join());
check("both copies count the same subscriber", route.subscriberCount("u1") === 1 && page.subscriberCount("u1") === 1);

page.publish("someone-else", { type: "items-changed", cause: "captured" });
check("another user's event is not delivered", heard.length === 1);

page.publishToAll(["u1", "u2"], { type: "groups-changed", cause: "shared", groupId: "g1" });
check("publishToAll crosses copies too", heard[1] === "groups-changed:shared", heard.join());

unsubscribe();
page.publish("u1", { type: "items-changed", cause: "updated" });
check("after unsubscribing, nothing more arrives", heard.length === 2);
check("and the user is gone from both copies", route.subscriberCount("u1") === 0 && page.subscriberCount("u1") === 0);

let threw = false;
const drop = page.subscribe("u3", () => {
  throw new Error("broken listener");
});
try {
  route.publish("u3", { type: "items-changed", cause: "updated" });
} catch {
  threw = true;
}
drop();
check("a listener that throws does not throw into the publisher", !threw);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
