"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { drain, refreshCount, subscribeConnectivity } from "@/lib/outbox-sync";

/**
 * Sends queued offline changes once there is a connection again.
 *
 * Mounted once in the root layout rather than on a page, because the reader is
 * not inside AppShell and marking an article read is the single most likely
 * thing to be queued. Renders nothing.
 */
export function OutboxSync() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      const sent = await drain();
      // Only disturb the page if something actually landed; a no-op drain on
      // every reconnect would refetch the queue for nothing.
      if (sent > 0 && !cancelled) router.refresh();
    };

    void refreshCount();
    void sync();

    const unsubscribe = subscribeConnectivity((online) => {
      if (online) void sync();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [router]);

  return null;
}
