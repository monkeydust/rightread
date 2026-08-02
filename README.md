<div align="center">

# rightread

**Capture links from anywhere. Read them clean, later, offline.**

</div>

Save a link from your phone's share sheet or your browser toolbar, and rightread
strips the page down to the article — no ads, no cookie banners, no newsletter
popups — and keeps it readable offline, in typography built for long reading.

No AI, no summaries, no tagging. Capture, extract, read, prioritise.

---

## What it does

**Capture from anywhere.** Android share sheet (PWA share target), an Edge/Chrome
extension, or a paste box in the app. All three hit one endpoint.

**Extract properly.** Mozilla Readability pulls out the article, DOMPurify
sanitises it under a strict allowlist, then a tidy pass removes the wrappers,
empty paragraphs and wiki `[edit]` links that Readability leaves behind. On a
Wikipedia page that is ~27% less markup for the same 30 paragraphs.

**Read offline.** A service worker caches every article you open. Serif type,
adjustable size and width, light/sepia/dark, and it remembers where you stopped.

**Prioritise.** One ordered queue with move up/down, a star for things that
matter, and an archive for things you've finished.

## Stack

Next.js 16 · React 19 · Prisma + SQLite · Auth.js (magic link via Resend) ·
Tailwind 4 · Docker behind Caddy

## Getting started

```bash
npm install
npx prisma db push        # creates prisma/dev.db
npm run dev               # http://localhost:3002
```

Sign in with your email. **Without a Resend key the magic link is printed to
the server console** — copy it from there.

### Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite path. Relative paths resolve from the project root. |
| `AUTH_SECRET` | Session signing key. `npx auth secret`. Never share it between apps. |
| `AUTH_URL` | Public origin in production. **Leave unset** for local/LAN use — see below. |
| `AUTH_TRUST_HOST` | `true`. Lets the sign-in link follow the host you opened. |
| `AUTH_RESEND_KEY` | Resend API key. Blank ⇒ link logged to the console. |
| `EMAIL_FROM` | Sender address for those emails. |

### Signing in from your phone on a LAN

Open rightread on the phone via the machine's LAN address
(`http://192.168.x.x:3002`), not `localhost`, and the sign-in link will point
back at that same address.

This relies on `AUTH_URL` being **unset**. Auth.js builds the magic-link URL
from `request.url`, which Next always reports as the address the server is
*bound* to — so a sign-in started on your phone produced a `localhost` link that
was dead on arrival. `src/app/api/auth/[...nextauth]/route.ts` rebuilds the
request URL from the `Host` header to fix that. Pin `AUTH_URL` in production and
that host-derivation switches off, which is what you want on a public box.

> **PWA features need HTTPS.** Chrome gates the share target, app install and
> service worker on a secure origin, and fails *silently* without one — over
> plain HTTP, "Add to Home screen" only makes a bookmark shortcut with no
> share-sheet entry. On a LAN you get a working website, not a working PWA.

## Capturing links

**Android** — open the site in Chrome, menu → **Install app**. rightread then
appears in the share sheet from any app. (iOS Safari has no share-target
support; use a Shortcut that POSTs to `/api/capture` instead.)

**Edge / Chrome extension** — `edge://extensions` → Developer mode → **Load
unpacked** → pick `extension/`. Create a capture token in Settings, paste it and
the server address into the extension options; it verifies both before saving.
Then use the toolbar button, `Ctrl+Shift+S`, or right-click → Save to rightread.

**Anything else**

```bash
curl -X POST https://your-host/api/capture \
  -H "Authorization: Bearer rr_your_token" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/article"}'
```

## How it works

| Area | Where |
| --- | --- |
| Extraction | `src/lib/extract.ts` — fetch + Readability |
| Sanitising | `src/lib/sanitize.ts` — DOMPurify allowlist |
| Tidying | `src/lib/tidy.ts` — structural cleanup |
| Capture | `src/lib/capture.ts`, `src/app/api/capture` |
| Ordering | `src/lib/reorder.ts` — sparse float positions |
| Reader | `src/app/read/[id]`, `.prose-reader` in `globals.css` |
| Offline | `public/sw.js` |

**Ordering** uses sparse floats: a move sets the item's position to the midpoint
of its new neighbours, so it writes one row rather than renumbering the list.
When a gap collapses below float precision the queue renormalises itself. There
is deliberately only one queue — starring marks and filters, it never reorders.

**Extraction runs detached** from the capture request, so sharing a link
confirms instantly and the text fills in a second later. A page that can't be
extracted stays in the list with the error, a retry, and a link to the original:
a failed extraction never loses the save. Re-extracting an article that already
reads fine can never make it worse — on failure the existing copy is kept.

## Data

The server holds the only copy of your library, so `scripts/db-merge.mjs` is
**additive** — it inserts, never updates or deletes, matches users by email
rather than row id, and is idempotent. Nothing is lost unless you delete it in
the app. `scripts/db-backup.mjs` uses SQLite's backup API, so it is safe against
a live database.

```bash
npm run db:backup
npm run db:merge -- --from other.db --to prisma/dev.db --dry-run
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full procedure.

## Security

- Article HTML is rendered with `dangerouslySetInnerHTML`, so it is sanitised
  with DOMPurify under a strict tag/attribute allowlist **before** it is stored.
  17 XSS payloads are covered by `tests/sanitize.test.mts`.
- `/api/capture` fetches user-supplied URLs server-side, so hosts are checked
  against private ranges (including cloud metadata at `169.254.169.254`) on
  **every redirect hop**, including client-side `<meta refresh>` bounces.
  *Known limitation:* the check is on the hostname, not the resolved address, so
  a DNS name deliberately pointed at `127.0.0.1` would not be caught.
- Capture tokens are stored as SHA-256 hashes; the plaintext is shown once.
- Cookie-authenticated capture is same-origin only. Cross-origin callers must
  use a bearer token, which a browser never attaches automatically.

## Scripts

```bash
npm run dev          # dev server
npm run build        # production build
npm test             # sanitize, url, tidy and db-merge suites
npm run lint
npm run db:backup    # timestamped, keeps the last 20
npm run db:merge     # additive merge between two databases
npm run icons        # regenerate app icons from scripts/make-icons.py
```

## Licence

Personal project — all rights reserved.
