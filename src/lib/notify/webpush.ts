/**
 * Web Push, sender side: VAPID (RFC 8292) and message encryption
 * (RFC 8291, `aes128gcm` from RFC 8188), on `node:crypto` alone.
 *
 * Written here rather than taken from the `web-push` package for one reason
 * that matters: a subscription endpoint is a URL a client handed us, and
 * every request to it must go through a fetch we control — https only, a
 * known push service only, no redirects, a timeout (see `isPushEndpoint` and
 * `sendPush`). The encryption is small and fixed by the RFCs, and it is
 * tested against RFC 8291's own worked example, byte for byte.
 *
 * Nothing in this file touches the database or the environment directly, so
 * all of it is testable offline.
 */

import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";

// ── Configuration ────────────────────────────────────────────────

export type VapidConfig = {
  /** Uncompressed P-256 point, base64url (87 characters). Public: the browser needs it. */
  publicKey: string;
  /** The matching 32-byte scalar, base64url. Never leaves the server. */
  privateKey: string;
  /** A contact for the push service: an https: or mailto: URL. */
  subject: string;
};

const DEFAULT_SUBJECT = "https://www.rightread.net";

function b64urlDecode(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Reads the VAPID keys, or null when notifications are not set up.
 *
 * Blank is the same as unset: Docker Compose passes a variable that is listed
 * but absent from the env file as the empty string. A key of the wrong size is
 * also "not set up", with one warning, rather than a send that fails every
 * time with nothing to say why.
 */
export function readVapidConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn
): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  if (!publicKey || !privateKey) return null;

  const pub = b64urlDecode(publicKey);
  const priv = b64urlDecode(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) {
    warn("[notify] VAPID keys are set but are not a P-256 key pair; notifications are off");
    return null;
  }

  const subject = env.VAPID_SUBJECT?.trim() || DEFAULT_SUBJECT;
  if (!/^(https:\/\/|mailto:)\S+$/.test(subject)) {
    warn("[notify] VAPID_SUBJECT must be an https: or mailto: URL; notifications are off");
    return null;
  }
  return { publicKey, privateKey, subject };
}

// ── Endpoints ────────────────────────────────────────────────────

/**
 * The push services browsers actually use. An endpoint anywhere else is not a
 * push subscription, whatever it claims.
 *
 * This is an allow list and not the `isPrivateHost` check `safeFetch` uses,
 * on purpose: that check looks at the host name, and a name can resolve to an
 * internal address. A subscription endpoint is supplied by a client and then
 * POSTed to by this server for ever after, so only named services will do.
 */
const PUSH_HOSTS: ReadonlyArray<RegExp> = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, most Chromium
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows
  /^[a-z0-9-]+\.push\.apple\.com$/, // Safari
];

const MAX_ENDPOINT_LENGTH = 2048;

/** True for an https URL, default port, no credentials, on a known push service. */
export function isPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((pattern) => pattern.test(host));
}

/** What may be logged about an endpoint: the service's host and nothing else. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid";
  }
}

/** A device's keys are only usable if they are the sizes the RFC fixes. */
export function validSubscriptionKeys(p256dh: unknown, auth: unknown): boolean {
  if (typeof p256dh !== "string" || typeof auth !== "string") return false;
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return false;
  const pub = b64urlDecode(p256dh);
  return pub.length === 65 && pub[0] === 4 && b64urlDecode(auth).length === 16;
}

// ── Encryption (RFC 8291) ────────────────────────────────────────

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF with a single block of output, which is all this ever needs (≤ 32 bytes). */
function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

const RECORD_SIZE = 4096;

/**
 * One record is all we send: 4096 bytes, less the 16-byte tag and the one
 * delimiter byte. Push services also cap the whole message at about 4 KB.
 */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 17;

/**
 * Encrypts a message for one device. Returns the request body.
 *
 * `salt` and `localPrivateKey` exist only so the test can reproduce the RFC's
 * example; a real send leaves them out and gets fresh random ones, which is
 * what makes each message unlinkable to the last.
 */
export function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
  fixed: { salt?: Uint8Array; localPrivateKey?: Uint8Array } = {}
): Buffer {
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("push payload too large");

  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);

  const ecdh = createECDH("prime256v1");
  if (fixed.localPrivateKey) ecdh.setPrivateKey(Buffer.from(fixed.localPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);

  const salt = Buffer.from(fixed.salt ?? randomBytes(16));
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (here, only) record.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// ── VAPID (RFC 8292) ─────────────────────────────────────────────

const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60; // the RFC allows at most 24 hours

/** The `Authorization` header value identifying this server to a push service. */
export function vapidAuthorization(endpoint: string, config: VapidConfig, nowMs = Date.now()): string {
  const pub = b64urlDecode(config.publicKey);
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: config.privateKey,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
  });

  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(nowMs / 1000) + TOKEN_LIFETIME_SECONDS,
        sub: config.subject,
      })
    )
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${config.publicKey}`;
}

// ── Sending ──────────────────────────────────────────────────────

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/**
 * - `sent`: the push service accepted it (it may still never reach the device).
 * - `gone`: 404 or 410 — the subscription no longer exists and must be deleted.
 * - `failed`: anything else. Kept; the next message tries again.
 */
export type PushOutcome = "sent" | "gone" | "failed";

export type PushFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Nothing here may await a request that cannot give up. */
export const PUSH_TIMEOUT_MS = 10_000;

/** How long the push service keeps a message for a phone that is off. */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * Sends one message to one device. Never throws.
 *
 * Redirects are refused rather than followed: a push service does not
 * redirect, and following one would let an endpoint steer this server's POST
 * somewhere the allow list never saw.
 */
export async function sendPush(
  target: PushTarget,
  payload: string,
  config: VapidConfig,
  fetchImpl: PushFetch = fetch
): Promise<PushOutcome> {
  if (!isPushEndpoint(target.endpoint)) return "gone";
  if (!validSubscriptionKeys(target.p256dh, target.auth)) return "gone";

  try {
    const body = encryptPayload(Buffer.from(payload, "utf8"), target.p256dh, target.auth);
    const res = await fetchImpl(target.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers: {
        Authorization: vapidAuthorization(target.endpoint, config),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(TTL_SECONDS),
        Urgency: "normal",
      },
      body: new Uint8Array(body),
    });
    // The body is of no use and is never read.
    await res.body?.cancel().catch(() => {});
    if (res.status === 404 || res.status === 410) return "gone";
    return res.status >= 200 && res.status < 300 ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
