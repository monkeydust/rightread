/**
 * Prints a fresh VAPID key pair for Web Push, in the two lines .env.prod wants.
 *
 *   docker run --rm rightread_app:latest node scripts/vapid-keys.mjs
 *
 * Run it once, at first deploy. The public key is handed to every browser
 * that switches notifications on; the private key signs each send and is a
 * secret. Generating a new pair later invalidates every existing device
 * subscription. Nothing is written to disk: copy the output into .env.prod.
 */
import { createECDH } from "node:crypto";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
console.log(`VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString("base64url")}`);
// The scalar is returned without leading zero bytes; the key is always 32.
const scalar = ecdh.getPrivateKey();
const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
console.log(`VAPID_PRIVATE_KEY=${privateKey.toString("base64url")}`);
