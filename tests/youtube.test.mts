/**
 * YouTube URL recognition — offline.
 *
 * youtubeVideoId is the gate: a hit routes capture to the metadata path, a
 * miss falls through to normal extraction. Both directions matter — a missed
 * video stores an apology, and a false hit on a channel page would build a
 * card for a video that does not exist.
 *
 * The live extraction (oEmbed + watch-page scrape) is network-dependent and
 * verified against the real production video before deploys, not here.
 */

import { youtubeVideoId } from "../src/lib/extract-video.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

// ── Video pages, in every shape people share them ─────────────────
for (const [url, id] of [
  ["https://www.youtube.com/watch?v=lXZb21CfeIY", "lXZb21CfeIY"],
  // The production item, verbatim — mobile host plus tracking params.
  [
    "https://m.youtube.com/watch?v=lXZb21CfeIY&pp=0gcJCWgCo7VqN5tDiggUQAFKEDdkN3dwMkIwM29najVCVDM%3D",
    "lXZb21CfeIY",
  ],
  ["https://youtu.be/lXZb21CfeIY", "lXZb21CfeIY"],
  ["https://youtu.be/lXZb21CfeIY?t=42", "lXZb21CfeIY"],
  ["https://www.youtube.com/shorts/abc123XYZ_-", "abc123XYZ_-"],
  ["https://www.youtube.com/live/abc123XYZ_-", "abc123XYZ_-"],
  ["https://www.youtube.com/embed/lXZb21CfeIY", "lXZb21CfeIY"],
  ["https://music.youtube.com/watch?v=lXZb21CfeIY", "lXZb21CfeIY"],
  ["https://www.youtube.com/watch?list=PLx&v=lXZb21CfeIY", "lXZb21CfeIY"],
] as Array<[string, string]>) {
  check(`video: ${url.slice(0, 60)}`, youtubeVideoId(url) === id, String(youtubeVideoId(url)));
}

// ── Not video pages — must fall through to normal extraction ──────
for (const url of [
  "https://www.youtube.com/@LangChain",
  "https://www.youtube.com/channel/UCabc",
  "https://www.youtube.com/playlist?list=PLxyz",
  "https://www.youtube.com/results?search_query=rust",
  "https://www.youtube.com/",
  "https://youtu.be/",
  // Similar-looking hosts that are not YouTube.
  "https://youtube.com.evil.example/watch?v=lXZb21CfeIY",
  "https://notyoutube.com/watch?v=lXZb21CfeIY",
  "https://example.com/watch?v=lXZb21CfeIY",
  // Malformed.
  "not a url",
  "",
] as string[]) {
  check(`not a video: ${url.slice(0, 55) || "(empty)"}`, youtubeVideoId(url) === null, String(youtubeVideoId(url)));
}

// A v= param that is not an id shape must not match.
check(
  "junk v= param rejected",
  youtubeVideoId("https://www.youtube.com/watch?v=<script>") === null
);

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
