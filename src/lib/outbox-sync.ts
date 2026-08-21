/**
 * The seam between the outbox and the network.
 *
 * Kept apart from `outbox.ts` so that module stays pure storage-and-replay with
 * no opinion about how a request is made, and testable without a fetch stub.
 */

import { drain as drainOutbox, refreshCount } from "@/lib/outbox";
import { netFetch, subscribeConnectivity } from "@/lib/connectivity";

export { refreshCount, subscribeConnectivity };

/** Replays everything queued, using the timeout-bounded client fetch. */
export function drain(): Promise<number> {
  return drainOutbox((url, init) => netFetch(url, init));
}
