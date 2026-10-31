"use client";

import { useState, useSyncExternalStore } from "react";
import { isOnline, isNetworkError, netFetch, subscribeConnectivity } from "@/lib/connectivity";
import { Working } from "@/components/Working";

/**
 * The button that actually compacts. Online only, and deliberately not
 * queued in the outbox: "archive what is older than a week" is relative to
 * when it runs, so replaying it later would archive a different set.
 */
export function CompactConfirm({ count }: { count: number }) {
  const online = useSyncExternalStore(subscribeConnectivity, isOnline, () => true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await netFetch("/api/compact", { method: "POST" }, 30_000);
      const body = (await res.json().catch(() => ({}))) as {
        digestId?: string;
        error?: string;
      };
      if (!res.ok || !body.digestId) {
        setError(body.error ?? `Couldn't compact (HTTP ${res.status}).`);
        setBusy(false);
        return;
      }
      // A full navigation: the queue and archive counts all changed.
      window.location.assign(`/read/${body.digestId}`);
    } catch (err) {
      setError(
        isNetworkError(err)
          ? "No connection. Compact needs the network; nothing was changed."
          : "Couldn't compact."
      );
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={run}
        disabled={busy || !online}
        title={!online ? "Compact needs a connection" : undefined}
        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60"
        style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
      >
        {busy && <Working />}
        {busy ? "Compacting…" : `Compact ${count} ${count === 1 ? "item" : "items"}`}
      </button>
      {error && (
        <p className="mt-2 text-[13px] text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
