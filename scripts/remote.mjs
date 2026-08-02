#!/usr/bin/env node
/**
 * Runs commands on the deployment server over SSH.
 *
 *   node scripts/remote.mjs "cmd one" "cmd two"
 *   node scripts/remote.mjs --put local.file /remote/path
 *
 * The box uses password authentication, and OpenSSH will not read a password
 * from a pipe — it demands a TTY — so this drives ssh2 programmatically
 * instead. Same approach as rightmind/tmp/deploy.js.
 *
 * Credentials come from the environment, never from this file:
 *   RR_SSH_HOST, RR_SSH_USER, RR_SSH_PASSWORD
 *
 * This script is committed; the values are not. See DEPLOYMENT.local.md.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { argv, env, exit } from "node:process";

// ssh2 isn't a dependency of the app itself — it's only needed for deploys, so
// it's borrowed from the sibling project rather than shipped in the image.
const require = createRequire(
  "file:///" + (env.RR_SSH2_FROM ?? "C:/Users/admin/claude_projects/rightmind/") + "package.json"
);
const { Client } = require("ssh2");

const HOST = env.RR_SSH_HOST;
const USER = env.RR_SSH_USER ?? "root";
const PASSWORD = env.RR_SSH_PASSWORD;

if (!HOST || !PASSWORD) {
  console.error("Set RR_SSH_HOST and RR_SSH_PASSWORD in the environment.");
  exit(2);
}

const conn = new Client();

function exec(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d) => {
        out += d;
        process.stdout.write(d);
      });
      stream.stderr.on("data", (d) => {
        out += d;
        process.stderr.write(d);
      });
      stream.on("close", (code) => resolve({ code, out }));
    });
  });
}

function put(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const data = readFileSync(localPath);
      // fastPut/createWriteStream can fail opaquely if the remote directory
      // doesn't exist; surface the actual path in the error.
      const ws = sftp.createWriteStream(remotePath);
      ws.on("close", () => resolve());
      ws.on("error", (e) =>
        reject(new Error(`${e.message} (writing to ${remotePath})`))
      );
      ws.end(data);
    });
  });
}

conn.on("ready", async () => {
  try {
    if (argv[2] === "--put") {
      await put(argv[3], argv[4]);
      console.log(`uploaded ${argv[3]} -> ${argv[4]}`);
    } else {
      for (const cmd of argv.slice(2)) {
        console.log(`\n\u001b[36m$ ${cmd}\u001b[0m`);
        const { code } = await exec(cmd);
        if (code !== 0) console.log(`\u001b[33m[exit ${code}]\u001b[0m`);
      }
    }
  } catch (e) {
    console.error("Failed:", e.message);
    conn.end();
    exit(1);
  }
  conn.end();
});

conn.on("error", (e) => {
  console.error("SSH error:", e.message);
  exit(1);
});

conn.connect({ host: HOST, port: 22, username: USER, password: PASSWORD, readyTimeout: 20000 });
