/**
 * Notifications — offline.
 *
 * No push is sent and no database is touched: the sender and the store are
 * handed in. The encryption is checked against the worked example in
 * RFC 8291 (appendix A), byte for byte, and by decrypting a fresh message
 * the way a browser would; the VAPID token is checked by verifying its
 * signature. What this cannot show is a real push service accepting a
 * request — that needs real keys and a real device.
 */

import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  verify,
} from "node:crypto";
import {
  NOTIFICATION_TYPES,
  isNotificationTypeId,
  resolvePreferences,
  wantsType,
} from "../src/lib/notify/types.ts";
import {
  MAX_PLAINTEXT_BYTES,
  encryptPayload,
  endpointHost,
  isPushEndpoint,
  readVapidConfig,
  sendPush,
  validSubscriptionKeys,
  vapidAuthorization,
  type PushOutcome,
  type PushTarget,
} from "../src/lib/notify/webpush.ts";
import {
  addressName,
  clip,
  deviceLabel,
  dispatch,
  groupShareMessage,
  othersInGroup,
  pushChannel,
  pushPayload,
  recipientsWanting,
  safePath,
  testMessage,
  type Channel,
  type Message,
} from "../src/lib/notify/core.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

// ── Registry and preferences ─────────────────────────────────────
check("registry: group_share exists", isNotificationTypeId("group_share"));
check("registry: unknown id refused", !isNotificationTypeId("nope") && !isNotificationTypeId(7));
check(
  "registry: ids are unique and well formed",
  new Set(NOTIFICATION_TYPES.map((t) => t.id)).size === NOTIFICATION_TYPES.length &&
    NOTIFICATION_TYPES.every((t) => /^[a-z_]+$/.test(t.id) && t.label && t.description)
);
check("prefs: no row means the default (on for group shares)", wantsType("group_share", undefined));
check("prefs: null means the default", wantsType("group_share", null));
check("prefs: stored off wins", !wantsType("group_share", false));
check("prefs: stored on wins", wantsType("group_share", true));
check("prefs: an unknown type is never wanted, even if stored on", !wantsType("retired", true));
{
  const rows = resolvePreferences([
    { type: "group_share", enabled: false },
    { type: "retired", enabled: true },
  ]);
  check(
    "prefs: Settings list is the registry, with stored choices applied",
    rows.length === NOTIFICATION_TYPES.length && rows[0].id === "group_share" && !rows[0].enabled
  );
  check("prefs: Settings list defaults with no rows", resolvePreferences([])[0].enabled === true);
}

// ── Recipients ───────────────────────────────────────────────────
check(
  "recipients: sharer excluded",
  JSON.stringify(othersInGroup(["a", "b", "c"], "b")) === '["a","c"]'
);
check("recipients: only members are ever considered", !othersInGroup(["a", "b"], "a").includes("z"));
check("recipients: a group of one notifies nobody", othersInGroup(["a"], "a").length === 0);
check("recipients: duplicates collapse", othersInGroup(["a", "b", "b"], "a").length === 1);
check(
  "recipients: type switched off excluded, default and on kept",
  JSON.stringify(
    recipientsWanting("group_share", ["a", "b", "c"], [
      { userId: "a", enabled: false },
      { userId: "c", enabled: true },
    ])
  ) === '["b","c"]'
);

// ── Message contents ─────────────────────────────────────────────
{
  const m = groupShareMessage({
    groupId: "g1",
    groupName: "Book club",
    shareId: "s1",
    sharerName: "Pat Example",
    sharerEmail: "pat@example.org",
    title: "How tides work",
    url: "https://www.example.org/tides?x=1",
  });
  check("message: title is the group name", m.title === "Book club");
  check(
    "message: body is who, title and host",
    m.body === "Pat Example shared: How tides work (example.org)",
    m.body
  );
  check("message: tap opens the group shelf", m.path === "/groups/g1");
  check("message: tag is per share, so a re-share replaces", m.tag === "share-s1");
  check("message: name preferred, address not included when there is a name", !m.body.includes("@"));

  const noName = groupShareMessage({
    groupId: "g1", groupName: "Book club", shareId: "s1", sharerName: null,
    sharerEmail: "pat@example.org", title: "How tides work", url: "https://example.org/a",
  });
  check(
    "message: no name falls back to the part of the address before the @",
    noName.body === "pat shared: How tides work (example.org)",
    noName.body
  );
  check("message: the full address is never in the notification", !noName.body.includes("@") && !noName.body.includes("pat@example.org") && !noName.title.includes("@"));
  check("payload: the full address is not in what is sent", !pushPayload("group_share", noName).includes("@"));

  const blankName = groupShareMessage({
    groupId: "g1", groupName: "Book club", shareId: "s1", sharerName: "   ",
    sharerEmail: "sam.reader+books@mail.example.org", title: "T", url: "https://example.org/a",
  });
  check("message: a blank name counts as no name", blankName.body.startsWith("sam.reader+books shared:"), blankName.body);

  check("addressName: part before the @", addressName("pat@example.org") === "pat");
  check("addressName: last @ is the separator", addressName('"odd@local"@example.org') === '"odd@local"');
  check("addressName: nothing before the @ is empty", addressName("@example.org") === "" && addressName(null) === "" && addressName("") === "");
  const noLocal = groupShareMessage({
    groupId: "g1", groupName: "G", shareId: "s1", sharerName: null,
    sharerEmail: "@example.org", title: "T", url: "https://example.org/a",
  });
  check("message: an address with nothing before the @ reads as Someone", noLocal.body.startsWith("Someone shared:"), noLocal.body);

  const bare = groupShareMessage({
    groupId: "g1", groupName: "", shareId: "s1", sharerName: null, sharerEmail: null,
    title: "example.org", url: "https://example.org/a",
  });
  check("message: nothing known still reads", bare.title === "rightread" && bare.body === "Someone shared: example.org", bare.body);

  const long = groupShareMessage({
    groupId: "g1", groupName: "G", shareId: "s1", sharerName: "P",
    sharerEmail: null, title: `A\n\tvery ${"long ".repeat(80)}title`, url: "https://example.org/a",
  });
  check("message: long title clipped, whitespace flattened", long.body.length < 200 && !/[\n\t]/.test(long.body) && long.body.includes("…"));

  const keys = Object.keys(JSON.parse(pushPayload("group_share", m))).sort().join(",");
  check("payload: exactly the fields the worker reads", keys === "body,path,tag,title,type,v", keys);
  const p = JSON.parse(pushPayload("group_share", m));
  check("payload: version 1 and the type", p.v === 1 && p.type === "group_share");
}
check("path: in-app path kept", safePath("/groups/abc") === "/groups/abc");
check("path: full URL refused", safePath("https://evil.example/") === "/");
check("path: protocol-relative refused", safePath("//evil.example/") === "/");
check("path: script refused", safePath("javascript:alert(1)") === "/");
check("clip: short text untouched", clip("  a  b ", 10) === "a b");
check("clip: long text ends in an ellipsis within the limit", clip("x".repeat(50), 10).length === 10);
{
  const huge: Message = { title: "t", body: "語".repeat(300), path: "/x", tag: "g" };
  const big = pushPayload("group_share", { ...huge, title: "語".repeat(80) });
  check("payload: always fits one record", Buffer.byteLength(big, "utf8") <= MAX_PLAINTEXT_BYTES);
  check("payload: test message opens settings", JSON.parse(pushPayload("test", testMessage())).path === "/settings");
}
check("device label: Chrome on Android", deviceLabel("Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/150.0 Mobile Safari/537.36") === "Chrome on Android");
check("device label: nothing known", deviceLabel(null) === "Browser");

// ── Endpoints ────────────────────────────────────────────────────
check("endpoint: FCM accepted", isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123"));
check("endpoint: Mozilla accepted", isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"));
check("endpoint: Windows accepted", isPushEndpoint("https://db5p.notify.windows.com/w/?token=abc"));
check("endpoint: Apple accepted", isPushEndpoint("https://web.push.apple.com/abc"));
check("endpoint: http refused", !isPushEndpoint("http://fcm.googleapis.com/fcm/send/abc"));
check("endpoint: other port refused", !isPushEndpoint("https://fcm.googleapis.com:8443/fcm/send/abc"));
check("endpoint: loopback refused", !isPushEndpoint("https://127.0.0.1/x"));
check("endpoint: internal name refused", !isPushEndpoint("https://rightread_app_1:3000/x"));
check("endpoint: metadata address refused", !isPushEndpoint("https://169.254.169.254/latest"));
check("endpoint: arbitrary site refused", !isPushEndpoint("https://example.org/push"));
check("endpoint: look-alike suffix refused", !isPushEndpoint("https://fcm.googleapis.com.evil.example/x"));
check("endpoint: look-alike prefix refused", !isPushEndpoint("https://evilfcm.googleapis.com/x"));
check("endpoint: credentials refused", !isPushEndpoint("https://user:pw@fcm.googleapis.com/x"));
check("endpoint: non-string refused", !isPushEndpoint(null) && !isPushEndpoint({ href: "x" }));
check("endpoint: overlong refused", !isPushEndpoint(`https://fcm.googleapis.com/${"a".repeat(3000)}`));
check("endpoint: only the host is loggable", endpointHost("https://fcm.googleapis.com/fcm/send/SECRET") === "fcm.googleapis.com");

// ── Encryption: RFC 8291 appendix A ──────────────────────────────
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** A browser's side of RFC 8291, written separately from the code under test. */
function decrypt(body: Buffer, uaPrivate: string, uaPublic: string, auth: string): string {
  const salt = body.subarray(0, 16);
  const idLen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(unb64u(uaPrivate));
  const shared = ecdh.computeSecret(asPublic);
  const hk = (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    createHmac("sha256", createHmac("sha256", s).update(ikm).digest())
      .update(Buffer.concat([info, Buffer.from([1])]))
      .digest()
      .subarray(0, n);
  const ikm = hk(unb64u(auth), shared, Buffer.concat([Buffer.from("WebPush: info\0"), unb64u(uaPublic), asPublic]), 32);
  const cek = hk(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hk(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  if (plain[plain.length - 1] !== 2) throw new Error("missing final-record delimiter");
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

{
  const body = encryptPayload(Buffer.from(RFC.plaintext), RFC.uaPublic, RFC.auth, {
    salt: unb64u(RFC.salt),
    localPrivateKey: unb64u(RFC.asPrivate),
  });
  check("encrypt: matches the RFC 8291 example byte for byte", b64u(body) === RFC.body, b64u(body));
  check(
    "encrypt: the RFC example decrypts with the device's key",
    decrypt(unb64u(RFC.body), RFC.uaPrivate, RFC.uaPublic, RFC.auth) === RFC.plaintext
  );

  const a = encryptPayload(Buffer.from("héllo ✓"), RFC.uaPublic, RFC.auth);
  const b = encryptPayload(Buffer.from("héllo ✓"), RFC.uaPublic, RFC.auth);
  check("encrypt: a fresh message decrypts", decrypt(a, RFC.uaPrivate, RFC.uaPublic, RFC.auth) === "héllo ✓");
  check("encrypt: two sends of the same text differ (fresh key and salt)", !a.equals(b));
  check("encrypt: record size 4096 and a 65-byte key id", a.readUInt32BE(16) === 4096 && a.readUInt8(20) === 65);

  let threw = false;
  try {
    encryptPayload(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1), RFC.uaPublic, RFC.auth);
  } catch {
    threw = true;
  }
  check("encrypt: refuses more than one record", threw);
}

check("keys: a real device key pair accepted", validSubscriptionKeys(RFC.uaPublic, RFC.auth));
check("keys: wrong sizes refused", !validSubscriptionKeys(RFC.auth, RFC.auth) && !validSubscriptionKeys(RFC.uaPublic, "AAAA"));
check("keys: non-strings and odd characters refused", !validSubscriptionKeys(null, RFC.auth) && !validSubscriptionKeys(`${RFC.uaPublic}=`, RFC.auth));

// ── VAPID ────────────────────────────────────────────────────────
const server = createECDH("prime256v1");
server.generateKeys();
const VAPID = {
  publicKey: b64u(server.getPublicKey()),
  privateKey: b64u(Buffer.concat([Buffer.alloc(32 - server.getPrivateKey().length), server.getPrivateKey()])),
  subject: "https://rightread.example",
};
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/invented-device-id";

{
  const now = 1_800_000_000_000;
  const header = vapidAuthorization(ENDPOINT, VAPID, now);
  const match = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  check("vapid: header has the RFC 8292 shape", match !== null, header.slice(0, 20));
  if (match) {
    const [, h, c, sig, k] = match;
    const head = JSON.parse(unb64u(h).toString());
    const claims = JSON.parse(unb64u(c).toString());
    check("vapid: ES256 JWT", head.alg === "ES256" && head.typ === "JWT");
    check("vapid: audience is the push service's origin, not the endpoint", claims.aud === "https://fcm.googleapis.com");
    check("vapid: expires within 24 hours", claims.exp > now / 1000 && claims.exp - now / 1000 <= 24 * 3600);
    check("vapid: carries the contact", claims.sub === VAPID.subject);
    check("vapid: k is the public key", k === VAPID.publicKey);
    const pub = unb64u(VAPID.publicKey);
    const key = createPublicKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
    });
    check(
      "vapid: signature verifies against the public key",
      verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, unb64u(sig))
    );
    check("vapid: the private key is not in the header", !header.includes(VAPID.privateKey));
  }
}

// ── Configuration: blank keys mean off ───────────────────────────
{
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  check("config: unset is off", readVapidConfig({}, warn) === null);
  check(
    "config: blank is off (Compose passes blank for a missing variable)",
    readVapidConfig({ VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "  " }, warn) === null
  );
  check("config: one key alone is off", readVapidConfig({ VAPID_PUBLIC_KEY: VAPID.publicKey }, warn) === null);
  check("config: off for those reasons is silent", warnings.length === 0);
  check(
    "config: a malformed key is off, with a warning",
    readVapidConfig({ VAPID_PUBLIC_KEY: "abc", VAPID_PRIVATE_KEY: "def" }, warn) === null && warnings.length === 1
  );
  check("config: the warning does not contain the key", !warnings.join().includes("abc"));
  const ok = readVapidConfig({ VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey }, warn);
  check("config: a real pair is on, with the default contact", ok?.subject === "https://www.rightread.net");
  check(
    "config: a contact that is not a URL is off",
    readVapidConfig({ VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: "me" }, warn) === null
  );
}

// ── sendPush ─────────────────────────────────────────────────────
const TARGET: PushTarget = { endpoint: ENDPOINT, p256dh: RFC.uaPublic, auth: RFC.auth };

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number | Error, calls: Call[] = []) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (status instanceof Error) throw status;
    return new Response(null, { status });
  };
}

{
  const calls: Call[] = [];
  const outcome = await sendPush(TARGET, '{"v":1}', VAPID, fakeFetch(201, calls));
  check("send: 201 is sent", outcome === "sent");
  const { url, init } = calls[0];
  const headers = init.headers as Record<string, string>;
  check("send: one POST to the endpoint", calls.length === 1 && url === ENDPOINT && init.method === "POST");
  check("send: redirects are refused", init.redirect === "manual");
  check("send: has a timeout", init.signal instanceof AbortSignal);
  check(
    "send: aes128gcm with a TTL and VAPID",
    headers["Content-Encoding"] === "aes128gcm" && Number(headers.TTL) > 0 && headers.Authorization.startsWith("vapid t=")
  );
  check(
    "send: the body decrypts to the payload",
    decrypt(Buffer.from(init.body as Uint8Array), RFC.uaPrivate, RFC.uaPublic, RFC.auth) === '{"v":1}'
  );
  check("send: the body is not the plaintext", !Buffer.from(init.body as Uint8Array).toString("latin1").includes('{"v":1}'));
}
check("send: 404 is gone", (await sendPush(TARGET, "{}", VAPID, fakeFetch(404))) === "gone");
check("send: 410 is gone", (await sendPush(TARGET, "{}", VAPID, fakeFetch(410))) === "gone");
check("send: 429 is failed, not gone", (await sendPush(TARGET, "{}", VAPID, fakeFetch(429))) === "failed");
check("send: 500 is failed", (await sendPush(TARGET, "{}", VAPID, fakeFetch(500))) === "failed");
check("send: a 302 is failed, never followed", (await sendPush(TARGET, "{}", VAPID, fakeFetch(302))) === "failed");
check("send: a network error is failed, not thrown", (await sendPush(TARGET, "{}", VAPID, fakeFetch(new Error("down")))) === "failed");
{
  const calls: Call[] = [];
  const outcome = await sendPush({ ...TARGET, endpoint: "https://10.0.0.5/push" }, "{}", VAPID, fakeFetch(201, calls));
  check("send: an endpoint off the allow list is never called, and is pruned", outcome === "gone" && calls.length === 0);
  const bad = await sendPush({ ...TARGET, p256dh: "AAAA" }, "{}", VAPID, fakeFetch(201, calls));
  check("send: unusable device keys are never called, and are pruned", bad === "gone" && calls.length === 0);
}

// ── The push channel: pruning and counting ───────────────────────
function memoryStore(rows: Record<string, Array<PushTarget & { id: string }>>) {
  const removed: string[] = [];
  const touched: string[] = [];
  return {
    removed,
    touched,
    store: {
      targets: async (userId: string) => rows[userId] ?? [],
      remove: async (ids: string[]) => void removed.push(...ids),
      touch: async (ids: string[]) => void touched.push(...ids),
    },
  };
}
const device = (id: string): PushTarget & { id: string } => ({ ...TARGET, id, endpoint: `${ENDPOINT}-${id}` });
const MESSAGE: Message = { title: "Book club", body: "Pat shared: Tides", path: "/groups/g1", tag: "share-s1" };

{
  const mem = memoryStore({ u1: [device("d1"), device("d2"), device("d3")] });
  const outcomes: Record<string, PushOutcome> = { d1: "sent", d2: "gone", d3: "failed" };
  const payloads: string[] = [];
  const channel = pushChannel({
    available: () => true,
    store: mem.store,
    send: async (target, payload) => {
      payloads.push(payload);
      return outcomes[target.endpoint.split("-").pop() as string];
    },
  });
  const count = await channel.deliver("u1", "group_share", MESSAGE);
  check("channel: every device is tried", payloads.length === 3);
  check("channel: counts sent, failed and pruned", count.sent === 1 && count.failed === 1 && count.pruned === 1);
  check("channel: only the gone device is removed", JSON.stringify(mem.removed) === '["d2"]');
  check("channel: only the accepted device is marked", JSON.stringify(mem.touched) === '["d1"]');
  check("channel: the payload carries the type", JSON.parse(payloads[0]).type === "group_share");
  check("channel: no devices is a quiet zero", (await channel.deliver("nobody", "group_share", MESSAGE)).sent === 0);
}
{
  const mem = memoryStore({ u1: [device("d1")] });
  const channel = pushChannel({
    available: () => true,
    store: { ...mem.store, remove: async () => { throw new Error("db down"); }, touch: async () => { throw new Error("db down"); } },
    send: async () => { throw new Error("boom"); },
  });
  let threw = false;
  const count = await channel.deliver("u1", "group_share", MESSAGE).catch(() => { threw = true; return null; });
  check("channel: a sender that throws is a failure, not an exception", !threw && count?.failed === 1);
}

// ── dispatch: the batch ──────────────────────────────────────────
function recordingChannel(available = true, behaviour: "ok" | "throw" = "ok") {
  const delivered: string[] = [];
  const channel: Channel = {
    id: "fake",
    available: () => available,
    async deliver(userId) {
      delivered.push(userId);
      if (behaviour === "throw") throw new Error("boom");
      return { sent: 1, failed: 0, pruned: 0 };
    },
  };
  return { channel, delivered };
}

{
  const { channel, delivered } = recordingChannel();
  const lines: string[] = [];
  const result = await dispatch(
    {
      channels: [channel],
      preferences: async () => [{ userId: "b", enabled: false }],
      log: (l) => lines.push(l),
    },
    "group_share",
    ["a", "b", "c", "a"],
    MESSAGE
  );
  check("dispatch: switched-off user skipped, duplicates collapsed", JSON.stringify(delivered.sort()) === '["a","c"]');
  check("dispatch: counts returned", result.recipients === 2 && result.sent === 2);
  check(
    "dispatch: exactly one log line, counts only",
    lines.length === 1 && lines[0] === "[notify] type=group_share recipients=2 sent=2 failed=0 pruned=0",
    lines.join(" | ")
  );
  check("dispatch: the log has no title, body, path or address", !/Book club|Tides|groups|@/.test(lines[0]));
}
{
  const { channel, delivered } = recordingChannel(false);
  let asked = false;
  const lines: string[] = [];
  const result = await dispatch(
    { channels: [channel], preferences: async () => { asked = true; return []; }, log: (l) => lines.push(l) },
    "group_share", ["a"], MESSAGE
  );
  check("dispatch: no keys means no delivery", delivered.length === 0 && result.sent === 0);
  check("dispatch: no keys means nothing is read and nothing logged", !asked && lines.length === 0);
}
{
  const { channel } = recordingChannel(true, "throw");
  const lines: string[] = [];
  let threw = false;
  const result = await dispatch(
    { channels: [channel], preferences: async () => [], log: (l) => lines.push(l) },
    "group_share", ["a", "b"], MESSAGE
  ).catch(() => { threw = true; return null; });
  check("dispatch: a channel that throws does not throw to the caller", !threw && result?.failed === 2);
}
{
  const { channel } = recordingChannel();
  const lines: string[] = [];
  let threw = false;
  const result = await dispatch(
    { channels: [channel], preferences: async () => { throw new Error("db down"); }, log: (l) => lines.push(l) },
    "group_share", ["a"], MESSAGE
  ).catch(() => { threw = true; return null; });
  check("dispatch: a database failure does not throw to the caller", !threw && result?.sent === 0);
  check("dispatch: and it is logged without detail", lines.length === 1 && lines[0] === "[notify] type=group_share error=Error", lines[0]);
}

console.log(failed === 0 ? "\nnotify: all checks passed" : `\nnotify: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
