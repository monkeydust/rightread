/**
 * Adversarial security tests — the ones written to break the guards, not
 * confirm they work on friendly input.
 *
 * Two fronts: the SSRF host check (capture fetches user-supplied URLs
 * server-side, so a private-range bypass is a door into the box and its cloud
 * metadata), and the sanitizer (article HTML is rendered with
 * dangerouslySetInnerHTML, so one surviving payload is stored XSS for the
 * account that saved it).
 */

import { JSDOM } from "jsdom";
import { isPrivateHost } from "../src/lib/extract.ts";
import { sanitizeArticleHtml } from "../src/lib/sanitize.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`      ${detail}`);
}

/** Feed a URL through the same parse the fetch path uses, then judge its host. */
function hostBlocked(url: string): boolean {
  try {
    return isPrivateHost(new URL(url).hostname);
  } catch {
    // A URL that will not parse never reaches fetch — treat as blocked.
    return true;
  }
}

// ── SSRF: everything that must be refused ─────────────────────────
for (const [url, why] of [
  ["http://localhost/", "localhost"],
  ["http://LocalHost/", "localhost, mixed case"],
  ["http://127.0.0.1/", "loopback"],
  ["http://127.0.0.2/", "loopback, whole /8"],
  ["http://0.0.0.0/", "unspecified"],
  ["http://10.0.0.5/", "private 10/8"],
  ["http://192.168.1.1/", "private 192.168"],
  ["http://172.16.0.1/", "private 172.16"],
  ["http://172.31.255.255/", "private 172.31"],
  ["http://169.254.169.254/", "AWS/GCP metadata"],
  ["http://metadata.google.internal/", "GCP metadata by name"],
  ["http://something.local/", ".local mDNS"],
  ["http://box.localhost/", ".localhost"],
  // IPv4 written in non-dotted forms — the URL parser normalises these back to
  // dotted decimal, so the guard must still catch them.
  ["http://2130706433/", "decimal 127.0.0.1"],
  ["http://0x7f000001/", "hex 127.0.0.1"],
  ["http://0177.0.0.1/", "octal 127.0.0.1"],
  ["http://127.1/", "shorthand 127.0.0.1"],
  // IPv6 — the class the guard used to miss entirely.
  ["http://[::1]/", "IPv6 loopback"],
  ["http://[fc00::1]/", "IPv6 unique-local"],
  ["http://[fd12:3456::1]/", "IPv6 ULA fd"],
  ["http://[fe80::1]/", "IPv6 link-local"],
  ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
  ["http://[::ffff:169.254.169.254]/", "IPv4-mapped metadata"],
] as const) {
  check(`SSRF blocks ${why}`, hostBlocked(url), url);
}

// ── SSRF: public hosts that must still be allowed ─────────────────
for (const [url, why] of [
  ["https://example.com/article", "ordinary site"],
  ["https://8.8.8.8/", "public IPv4"],
  ["https://[2606:4700:4700::1111]/", "public IPv6 (Cloudflare)"],
  ["https://172.15.0.1/", "172.15 is public (below the private block)"],
  ["https://172.32.0.1/", "172.32 is public (above the private block)"],
  ["https://11.0.0.1/", "11/8 is public"],
] as const) {
  check(`SSRF allows ${why}`, !hostBlocked(url), url);
}

// ── Sanitizer: an mXSS / obfuscation corpus ───────────────────────
const window = new JSDOM("").window;
const clean = (html: string) =>
  sanitizeArticleHtml(window as never, html, "https://example.com/a");

for (const [name, payload] of [
  ["nested script in svg", `<svg><script>alert(1)</script></svg>`],
  ["mixed-case script", `<ScRiPt>alert(1)</ScRiPt>`],
  ["img onerror", `<img src=x onerror="alert(1)">`],
  ["body onload", `<body onload="alert(1)">hi</body>`],
  ["details ontoggle", `<details open ontoggle="alert(1)">x</details>`],
  ["a javascript href", `<a href="javascript:alert(1)">x</a>`],
  ["a vbscript href", `<a href="vbscript:msgbox(1)">x</a>`],
  ["href with tab", `<a href="java\tscript:alert(1)">x</a>`],
  ["href with newline", `<a href="java\nscript:alert(1)">x</a>`],
  ["entity-encoded js href", `<a href="&#106;avascript:alert(1)">x</a>`],
  ["data html object", `<object data="data:text/html,<script>alert(1)</script>">x</object>`],
  ["iframe srcdoc", `<iframe srcdoc="<script>alert(1)</script>">x</iframe>`],
  ["style expression", `<div style="width:expression(alert(1))">x</div>`],
  ["form action", `<form action="javascript:alert(1)"><button>x</button></form>`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`],
  ["base tag hijack", `<base href="javascript:alert(1)//">`],
  ["marquee onstart", `<marquee onstart="alert(1)">x</marquee>`],
  ["math mtext", `<math><mtext><script>alert(1)</script></mtext></math>`],
  // The classic mXSS: markup that is inert until the browser re-parses it.
  ["mXSS noscript", `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`],
  ["mXSS malformed comment", `<!--><img src=x onerror=alert(1)>-->`],
  ["svg foreignObject", `<svg><foreignObject><script>alert(1)</script></foreignObject></svg>`],
] as const) {
  const out = clean(payload).toLowerCase();
  const leaked =
    out.includes("onerror") ||
    out.includes("onload") ||
    out.includes("ontoggle") ||
    out.includes("onstart") ||
    out.includes("<script") ||
    out.includes("javascript:") ||
    out.includes("vbscript:") ||
    out.includes("expression(") ||
    out.includes("<iframe") ||
    out.includes("<object") ||
    out.includes("srcdoc") ||
    out.includes("<form") ||
    out.includes("<base");
  check(`sanitizer neutralises: ${name}`, !leaked, out.slice(0, 120));
}

// Sanitizer must still keep the article itself.
{
  const out = clean(`<p>Real <strong>text</strong> with a <a href="https://ok.com/x">link</a>.</p>`);
  check("sanitizer keeps real prose", /Real/.test(out) && /<strong>/.test(out));
  check("sanitizer keeps a safe link", /href="https:\/\/ok\.com\/x"/.test(out));
  check("sanitizer hardens the link", /rel="noopener noreferrer nofollow"/.test(out));
}

console.log(failed === 0 ? "\nAll security tests pass." : `\n${failed} FAILING`);
process.exit(failed === 0 ? 0 : 1);
