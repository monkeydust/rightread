/**
 * The reader's "is this page still true?" check.
 *
 * A reader page is served from the service worker's cache at once, so a page
 * cached while its extraction was pending or failed kept saying so after the
 * article had been stored. These pin when the page reloads, when it keeps
 * asking, when it gives up, and that it cannot reload in a loop.
 */
import {
  RELOAD_GUARD_MS,
  WATCH_LIMIT_MS,
  reloadAllowed,
  reloadGuard,
  watchStep,
} from "../src/lib/extraction-watch.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

check("failed page, item now ok: reload", watchStep("failed", "ok") === "reload");
check("failed page, item being retried: reload (to the pending page)", watchStep("failed", "pending") === "reload");
check("failed page, item still failed: stop", watchStep("failed", "failed") === "stop");
check("failed page, server unreachable: stop", watchStep("failed", null) === "stop");
check("pending page, item now ok: reload", watchStep("pending", "ok") === "reload");
check("pending page, item now failed: reload (to the failure)", watchStep("pending", "failed") === "reload");
check("pending page, item still pending: keep asking", watchStep("pending", "pending") === "poll");
check("pending page, server unreachable: keep asking", watchStep("pending", null) === "poll");

const t = 1_000_000;
check("no guard: reload allowed", reloadAllowed(null, "failed", t));
check("same state reloaded a moment ago: refused", !reloadAllowed(reloadGuard("failed", t), "failed", t + 2000));
check("same state, guard expired: allowed", reloadAllowed(reloadGuard("failed", t), "failed", t + RELOAD_GUARD_MS + 1));
check("failed → pending → ok in quick succession is not a loop", reloadAllowed(reloadGuard("failed", t), "pending", t + 2000));
check("a garbled guard does not block", reloadAllowed("nonsense", "failed", t) && reloadAllowed("failed:abc", "failed", t));
check("a pending page outlasts the fallback's 150 s budget", WATCH_LIMIT_MS > 150_000);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
