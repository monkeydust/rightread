"use client";

import { useCallback, useEffect, useState } from "react";
import { netFetch } from "@/lib/connectivity";

type TypeRow = { id: string; label: string; description: string; enabled: boolean };

/**
 * What this device can do about notifications, in the order the checks run.
 * `checking` is the first render, before the browser has been asked anything.
 */
type DeviceState = "checking" | "unsupported" | "blocked" | "off" | "on";

const STATUS: Record<DeviceState, string> = {
  checking: "",
  unsupported: "This browser cannot show notifications.",
  blocked:
    "Blocked in this browser's site settings. Allow notifications for this site, then switch on.",
  off: "Off.",
  on: "On.",
};

/** The browser wants the server's public key as bytes, not base64url text. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The service worker, or null if none takes control in a few seconds. */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000));
  return Promise.race([ready, timeout]).catch(() => null);
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" ? data.error : fallback;
}

/**
 * Settings → Notifications.
 *
 * One switch for this device, one per notification type, and a test button.
 * The browser's permission prompt is only ever raised by a tap on the device
 * switch, never on load. Everything here needs the network (the browser's
 * push service as much as our server), so nothing is queued for later: a
 * failure is said and the switch stays where it was.
 */
export function NotificationSettings({
  available,
  publicKey,
  deviceHashes,
  types,
}: {
  /** False when the server has no VAPID keys. */
  available: boolean;
  publicKey: string | null;
  /** SHA-256 of each endpoint registered to this user; never the endpoints. */
  deviceHashes: string[];
  types: TypeRow[];
}) {
  const [device, setDevice] = useState<DeviceState>("checking");
  const [rows, setRows] = useState(types);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  // What the browser and the server each think, reconciled. "On" needs all
  // three: permission, a browser subscription, and our row for it.
  const check = useCallback(async (): Promise<DeviceState> => {
    if (!supported()) return "unsupported";
    if (Notification.permission === "denied") return "blocked";
    const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
    const sub = await reg?.pushManager.getSubscription().catch(() => null);
    if (!sub || Notification.permission !== "granted") return "off";
    return deviceHashes.includes(await sha256Hex(sub.endpoint)) ? "on" : "off";
  }, [deviceHashes]);

  useEffect(() => {
    let cancelled = false;
    void check().then((state) => {
      if (!cancelled) setDevice(state);
    });
    return () => {
      cancelled = true;
    };
  }, [check]);

  async function switchOn() {
    if (!publicKey) return;
    const permission = await Notification.requestPermission();
    if (permission === "denied") {
      setDevice("blocked");
      return;
    }
    if (permission !== "granted") return; // dismissed: still "off", ask again next tap

    const reg = await registration();
    if (!reg) throw new Error("The app is not fully installed yet. Reload and try again.");

    let sub = await reg.pushManager.getSubscription();
    const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
    if (!sub) {
      sub = await reg.pushManager.subscribe(options);
    } else {
      // A subscription made under an older server key cannot be reused, and
      // the browser refuses to replace it in place.
      const held = sub.options.applicationServerKey;
      const same =
        held &&
        btoa(String.fromCharCode(...new Uint8Array(held))) ===
          btoa(String.fromCharCode(...options.applicationServerKey));
      if (!same) {
        await sub.unsubscribe();
        sub = await reg.pushManager.subscribe(options);
      }
    }

    const res = await netFetch("/api/push/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) throw new Error(await errorOf(res, "Could not switch notifications on"));
    setDevice("on");
  }

  async function switchOff() {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      // The server first: if this fails the device is still honestly "on".
      const res = await netFetch("/api/push/subscription", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      if (!res.ok) throw new Error(await errorOf(res, "Could not switch notifications off"));
      await sub.unsubscribe().catch(() => {});
    }
    setDevice("off");
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      const offline = err instanceof DOMException && err.name === "AbortError";
      setMessage({
        text: offline
          ? "No connection. Try again when you are online."
          : err instanceof Error && err.message
            ? err.message
            : "Something went wrong",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  async function setType(id: string, enabled: boolean) {
    const res = await netFetch("/api/push/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: id, enabled }),
    });
    if (!res.ok) throw new Error(await errorOf(res, "Could not save that"));
    setRows((current) => current.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }

  async function sendTest() {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) {
      setDevice("off");
      return;
    }
    const res = await netFetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (res.status === 410) setDevice("off");
    if (!res.ok) throw new Error(await errorOf(res, "Could not send a test"));
    setMessage({ text: "Sent. It should arrive within a few seconds.", error: false });
  }

  const muted = { color: "var(--text-muted)" };

  if (!available) {
    return (
      <section>
        <h2 className="text-sm font-semibold">Notifications</h2>
        <p className="mt-1 text-[13px]" style={muted}>
          Notifications are not set up on this server.
        </p>
      </section>
    );
  }

  const canToggle = device === "on" || device === "off";

  return (
    <section>
      <h2 className="text-sm font-semibold">Notifications</h2>
      <p className="mt-1 text-[13px]" style={muted}>
        Sent to this phone or browser by rightread. Each device is switched on separately.
      </p>

      <div className="mt-3 flex items-center justify-between gap-3 border-b py-2" style={{ borderColor: "var(--border)" }}>
        <div className="min-w-0">
          <p className="text-sm">Notifications on this device</p>
          <p className="text-[12px]" style={muted} aria-live="polite">
            {STATUS[device]}
          </p>
        </div>
        <Switch
          label="Notifications on this device"
          checked={device === "on"}
          disabled={busy || !canToggle}
          onChange={(next) => void run(next ? switchOn : switchOff)}
        />
      </div>

      {rows.map((row) => (
        <div
          key={row.id}
          className="flex items-center justify-between gap-3 border-b py-2"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="min-w-0">
            <p className="text-sm">{row.label}</p>
            <p className="text-[12px]" style={muted}>
              {row.description}
            </p>
          </div>
          <Switch
            label={row.label}
            checked={row.enabled}
            disabled={busy}
            onChange={(next) => void run(() => setType(row.id, next))}
          />
        </div>
      ))}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void run(sendTest)}
          disabled={busy || device !== "on"}
          className="rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
          style={{ borderColor: "var(--border)" }}
        >
          Send a test notification
        </button>
        {message && (
          <p
            className={`text-[13px] ${message.error ? "text-red-600" : ""}`}
            style={message.error ? undefined : muted}
            role={message.error ? "alert" : "status"}
          >
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-40"
      style={{
        borderColor: checked ? "var(--accent)" : "var(--border)",
        background: checked ? "var(--accent)" : "transparent",
      }}
    >
      <span
        aria-hidden
        className="absolute top-0.5 h-[18px] w-[18px] rounded-full transition-all"
        style={{
          left: checked ? "calc(100% - 20px)" : "2px",
          background: checked ? "var(--accent-ink)" : "var(--text-muted)",
        }}
      />
    </button>
  );
}
