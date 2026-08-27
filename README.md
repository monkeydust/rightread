<div align="center">

# rightread

**Capture links from anywhere. Read them clean, later, offline.**

<img src="docs/demo.gif" alt="Pasting a link into rightread and watching it save and extract" width="360">

_Paste a link. It gets extracted and it's ready to read, clean and offline._
**[▶ Watch the full walkthrough](docs/walkthrough.mp4)** covers save, search by meaning, read, trails, offline, and how your library connects.

</div>

Save a link from your phone's share sheet or your browser toolbar. rightread
strips the page down to the article, with no ads, no cookie banners and no
newsletter popups, and keeps it readable offline in typography built for long
reading.

## Why this exists

On 22 May 2025, Mozilla [announced it was winding Pocket
down](https://blog.mozilla.org/en/mozilla/building-whats-next/). The app closed
on 8 July, with an export window until 8 October, after which the data was
deleted. Mozilla said the way people use the web had changed and its resources
were better spent elsewhere.

I'd used Pocket for years, for one unglamorous thing: saving something on my
phone and reading it properly later, usually somewhere with no signal. When it
closed I looked at the alternatives. They were mostly fine, but each one was
either somebody else's server holding my reading, or a subscription, or an
"AI-powered reading assistant" that wanted to summarise the article instead of
letting me read it.

So I built the small thing I actually missed. One queue, clean text, works on a
plane. It runs on a server I control, and the whole library is a single SQLite
file I can copy.

One caveat worth stating plainly, because it's the sort of claim people
shouldn't have to take on trust. Your reading list lives on your own server, but
the AI features are not local. When they're switched on, an article's text goes
to [OpenRouter](https://openrouter.ai) to be classified and embedded. Leave
`OPENROUTER_API_KEY` unset and none of that happens: no article text leaves the
box, and capturing, extracting, reading, keyword search and the queue all work
exactly as before.

## Built AI-second

I built this AI-second rather than AI-first. The plain version had to work
properly before a model was allowed anywhere near it.

That's a practical choice, not a philosophical one. Every AI feature here leans
on the plain one underneath it. Semantic search is useless if extraction
produces junk, and a similarity graph over badly parsed pages is a picture of
your parser's mistakes.

The commit history is the honest record. **The first commit contains no AI code
at all.** No model calls, no embeddings, nothing. What it does contain is
fetching, [Readability](https://github.com/mozilla/readability) extraction,
sanitising, the reader, and the ordered queue. The capture-and-read loop worked,
and was deployed and in daily use, before a model touched anything.

Then, in order:

| | |
|---|---|
| **First** | capture, extract, sanitise, read, reorder, offline |
| **Then** | page classification, the first model call in the codebase |
| **Then** | keyword search (SQLite FTS5), and semantic search beside it |
| **Then** | the similarity graph, and Discover, both built on embeddings that already existed |

Two rules fell out of that order, and they're the part I'd keep if I built it
again.

**AI sits at the edges, never in the way.** Classification, semantic search and
recommendations decorate a product that already works without them. None of them
sits between you and an article.

**Every AI feature is fail-soft by contract.** No model call may break a
capture, a search or a page render. Miss the API key entirely and pages classify
as `other`, semantic search returns nothing, and Discover is empty, while
everything else behaves exactly as it did before. That's tested, not hoped for.

The cost is real, and worth naming. Building this way is slow to reach anything
impressive. For the first stretch the app was a list of links and some text,
nothing you'd screenshot, with every interesting feature still ahead of it.

What it bought is the numbers in the sections below. The similarity floors, the
classifier accuracy, the graph percentiles: those exist because there was a
working non-AI version to measure the AI against. Several values that *sounded*
right turned out to be wrong the moment they were measured. The semantic search
floor was set so high it silently returned nothing, and the first recommendations
shipped at a threshold that couldn't tell "related" from "both are long English
prose". I only caught either one because the plain version was there to compare
against.

---

## What it does

**Capture from anywhere.** Android share sheet (PWA share target), an Edge/Chrome
extension, or a paste box in the app. All three hit one endpoint.

**Extract properly.** Mozilla Readability pulls out the article, DOMPurify
sanitises it under a strict allowlist, then a tidy pass removes the wrappers,
empty paragraphs and wiki `[edit]` links that Readability leaves behind. On a
Wikipedia page that's about 27% less markup for the same 30 paragraphs.

**Read offline.** A service worker caches every article you open. Serif type,
adjustable size and width, light/sepia/dark, and it remembers where you stopped.

**Prioritise.** One ordered queue with move up/down, a star for things that
matter, and an archive for things you've finished.

**Bring things to you.** Add sites to watch and topics you care about, and
matching articles collect under Discover. See [Discover](#discover).

**Search two ways.** Keyword search over the full text, and semantic search that
finds pages about what you asked even when they never use your words. Results
stay in separate labelled groups. See [Search](#search).

**See how it connects.** A force-directed map of the whole library, built from
the same embeddings, where the clusters are reading interests nobody declared.
See [Graph](#graph).

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
the server console.** Copy it from there.

### Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite path. Relative paths resolve from the project root. |
| `AUTH_SECRET` | Session signing key. `npx auth secret`. Never share it between apps. |
| `AUTH_URL` | Public origin in production. **Leave unset** for local/LAN use (see below). |
| `AUTH_TRUST_HOST` | `true`. Lets the sign-in link follow the host you opened. |
| `AUTH_RESEND_KEY` | Resend API key. Blank means the link is logged to the console. |
| `EMAIL_FROM` | Sender address for those emails. Must be at a **Resend-verified domain** once there's more than one user; the shared `resend.dev` sender only reaches the account owner. |
| `RIGHTREAD_ALLOWED_EMAILS` | Comma-separated list of addresses allowed to sign in. **Blank means nobody can.** See [Who can sign in](#who-can-sign-in). |
| `OPENROUTER_API_KEY` | OpenRouter key. Without it classification degrades to `other` and nothing breaks. |
| `OPENROUTER_MODEL` | Defaults to `openai/gpt-5.6-luna`. One model for all of rightread. |
| `OPENROUTER_EMBED_MODEL` | Defaults to `openai/text-embedding-3-small`. Changing it invalidates stored vectors, so re-run `search:backfill --force`. |
| `OPENROUTER_SEMANTIC_FLOOR` | Similarity cut-off, 0 to 1. Defaults to `0.22` (measured, see [Search](#search)). |
| `GRAPH_EDGE_FLOOR` | Graph noise guard, 0 to 1. Defaults to `0.15`. Document-to-document, so **not** the same quantity as the two floors above. |
| `GRAPH_MAX_NODES` | Cap on graph size. Defaults to `2000`; anything omitted is reported in the UI. |
| `RIGHTREAD_PHRASE_FLOOR` | Key-phrase cut-off, 0 to 1. Defaults to `0.32` (measured, see [Discover](#discover)). |
| `RIGHTREAD_REC_FLOOR` | Article-to-article cut-off for recommendations. Defaults to `0.45`. |

> Any variable the app reads at runtime needs an explicit entry under
> `environment:` in `docker-compose.yml`. `--env-file` only makes it available
> for `${...}` substitution *in that file*. It does **not** pass the value into
> the container. Give each one a `:-` default there too. A variable listed
> without one, and absent from the env file, arrives as an **empty string**
> rather than unset, which `??` does not catch. The one deliberate exception is
> `RIGHTREAD_ALLOWED_EMAILS`, where empty already means the safe thing (deny
> everyone) and a default would be a hard-coded back door in a tracked file.

### Who can sign in

rightread is multi-user, and every row is scoped to a `userId`, but it is not
open registration. Anyone who can reach the login page can request a magic link,
so `RIGHTREAD_ALLOWED_EMAILS` decides who actually gets one:

```bash
RIGHTREAD_ALLOWED_EMAILS="you@example.com,someone@else.com"
```

Commas, semicolons and whitespace all separate; case and surrounding spaces are
ignored. The list is checked in the Auth.js `signIn` callback
(`src/lib/allowlist.ts`), which runs **twice** per sign-in, once before the email
goes out and once when the link is clicked, so removing an address invalidates
any link already sitting in that person's inbox. Existing sessions are not
revoked; delete the user row for that.

**Empty or unset denies everyone, on purpose.** A missing variable that meant
"let anybody in" would be a silent, production-only hole of exactly the shape
`src/lib/env.ts` exists to prevent. Locking the door is loud, shows up in the
log, and is fixed by setting one variable. Adding a person is that variable plus
a restart, with no migration, and their library starts empty.

### Signing in from your phone on a LAN

Open rightread on the phone via the machine's LAN address
(`http://192.168.x.x:3002`), not `localhost`, and the sign-in link will point
back at that same address.

This relies on `AUTH_URL` being **unset**. Auth.js builds the magic-link URL from
`request.url`, which Next always reports as the address the server is *bound* to,
so a sign-in started on your phone used to produce a `localhost` link that was
dead on arrival. `src/app/api/auth/[...nextauth]/route.ts` rebuilds the request
URL from the `Host` header to fix that. Pin `AUTH_URL` in production and that
host-derivation switches off, which is what you want on a public box.

> **PWA features need HTTPS.** Chrome gates the share target, app install and
> service worker on a secure origin, and fails *silently* without one. Over plain
> HTTP, "Add to Home screen" only makes a bookmark shortcut with no share-sheet
> entry. On a LAN you get a working website, not a working PWA.

## Capturing links

**Android.** Open the site in Chrome, menu → **Install app**. rightread then
appears in the share sheet from any app. (iOS Safari has no share-target support;
use a Shortcut that POSTs to `/api/capture` instead.)

**Edge / Chrome extension.** `edge://extensions` → Developer mode → **Load
unpacked** → pick `extension/`. Create a capture token in Settings, paste it and
the server address into the extension options, and it verifies both before
saving. Then use the toolbar button, `Ctrl+Shift+S`, or right-click → Save to
rightread.

**Anything else.**

```bash
curl -X POST https://your-host/api/capture \
  -H "Authorization: Bearer rr_your_token" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/article"}'
```

## Classification

Every saved page is classified on capture into one of five kinds
(`conversation`, `article`, `blog`, `reference`, `other`), which will select the
summary prompt. Three layers, in order:

1. **URL rules** (`src/lib/classify/rules.ts`), about ten hosts where extraction
   is known to fail. This isn't an optimisation. A server-side fetch of Reddit
   returns an 8 KB JavaScript shell, and in evaluation **5 of 9 rule-matched URLs
   failed extraction entirely** (HN 429, Stack Overflow 403, Reddit and YouTube
   unreadable). For those the URL is the only signal there is.
2. **The model**, for everything else, from title, URL and the first ~6 KB of
   extracted text. It handles the long tail no rule table reaches.
3. **`other`**, whenever the model is unavailable. Classification never throws
   and never blocks a capture.

A manual override in the UI sets `kindSource: "user"` and is never recomputed.

**Measured accuracy: 44/44** across a 29-URL tuning set and a 15-URL held-out
set the prompt was never adjusted against. About 1.3 s median, **$0.000138 per
page**.

```bash
npm run eval:classify                                 # tuning set
npm run eval:classify -- --fixture holdout-urls.json  # held-out set
npm run eval:classify -- --only rule                  # offline, no spend
```

The eval runs the *real* pipeline, the same fetch, extraction and sanitising as
production, because feeding the classifier hand-cleaned text would measure
something easier than what ships.

## Search

Two searches run on every query, and their results show as **separate, labelled
groups** that are never merged into one ranking. A keyword hit is a fact: the
words are on the page. A semantic hit is a guess. Blending them into a single
order hides which is which.

**Exact matches** use SQLite FTS5 over title, excerpt, body and URL.

| You type | You get |
|---|---|
| `rust async` | pages containing both words |
| `"memory safety"` | that exact phrase |
| `data*` | data, database, dataset |
| `"web assem"*` | prefix search on a phrase |

Ranked with bm25, weighted so a term in the title outranks the same term buried
in the body, and returned with a snippet around the match. Everything else
(parens, `AND`, `NOT`, `NEAR`, hyphens, stray quotes) is treated as literal text,
so a search can match nothing but can never raise a syntax error.

The index is maintained by **SQLite triggers**, not by application code.
App-level sync is only as complete as the set of write paths you remembered. One
stray `updateMany` and the index rots silently, which is the worst failure a
search index has.

**Related by meaning** uses a 1536-dimension embedding per item (~6 KB), stored
as a float32 BLOB and compared by cosine similarity. Anything already found by
keyword is excluded, so the second group is genuinely additional.

Brute-force comparison across every vector is a deliberate call. A thousand items
is low single-digit milliseconds, set against adding a vector extension and a
build dependency to the image. Revisit around 50k items, not before.

The similarity floor was **measured, not guessed**. An initial guess of 0.34 sat
*above* most real matches, so semantic search silently returned nothing:

| Query type | Similarity |
|---|---|
| irrelevant ("cooking pasta recipes") | 0.151 ceiling |
| conceptual ("data races" → Rust ownership) | 0.291 |
| direct ("ownership" → Rust ownership) | 0.345 |
| strong ("react hooks" → useEffect guide) | 0.542 |

0.22 clears the noise ceiling with headroom. It's specific to the embedding
model, so change the model and re-measure. `OPENROUTER_SEMANTIC_FLOOR` overrides
it. Out-of-range values are refused with a warning rather than silently accepted,
because a floor of 0 means "return the entire library".

Existing items are indexed with `npm run search:backfill`. Startup rebuilds the
keyword index automatically, since it has to be dropped before `prisma db push`,
which would otherwise refuse to run rather than drop objects it does not own.

## Graph

`/graph` places every saved page near the ones it resembles, using the same
embeddings as search. Nothing is tagged by hand and no new API calls are made.
The vectors already exist, so this is arithmetic over data already paid for.

Colour is the page kind, size is length, line weight is connection strength, and
a dashed coral line means the two pages are the same article saved twice.
Hovering isolates a neighbourhood. The whole thing is also rendered as a plain
list, which is both the accessible path and often the faster answer to "what is
this actually near?".

**Edges are top-k per page, not a global threshold.** Each page keeps links to
its k most similar neighbours (2 to 8, default 4). Edge count is then bounded by
`n·k`, so density stays constant as the library grows. It can't collapse into a
hairball, and no page is ever stranded.

**The strength bands calibrate themselves.** This is the part that matters.
Measured across 21,321 real pairs:

| | Cosine |
|---|---|
| median pair | 0.241 |
| 90th percentile | 0.417 |
| 99th percentile | 0.571 |

Two *unrelated* long documents still score around 0.24, because they share the
"this is long English prose" direction. `src/lib/sources/similar.ts` hit the same
wall independently, shipping bad recommendations at a fixed 0.38. So a constant
can't separate "related" from "both are prose": 0.43 sounds close and is merely
the 90th percentile, one random pair in ten.

Instead the bands are derived from the user's own corpus at build time, so
**strong** means "closer than 99% of pairs in *this* library". That stays true if
the embedding model changes or the library is all one topic. The legend states
the bands in those terms rather than showing a bare cosine, so the picture does
not imply more than the data supports.

Mean-centering the corpus is the textbook fix for the shared-prose direction. I
tried it and rejected it: on the same 207 documents it left neighbour rankings
essentially unchanged while *reducing* spread (sd 0.118 to 0.103). Top-k depends
only on ordering, so it bought nothing.

Layout is `d3-force` (simulation only; the rendering is ours), drawn as SVG so
hit-testing, focus and theming come free. Positions are written straight to SVG
attributes rather than through React state, because a `setState` per node per
frame would make React the bottleneck and the settle would visibly stutter.

Cost at 207 nodes: 21,321 pairs scored in **44 ms**, giving 709 edges at 3.3%
density with no isolated nodes.

## Discover

Everything else in rightread is reactive. It needs an article in hand before it
can tell you anything. Discover is the opposite: declare an interest once and it
brings things to you.

**Listeners** are sites you add in Settings. Paste `lobste.rs`, not a feed URL.
The app reads the page's `<link rel="alternate">` and falls back to `/feed`,
`/rss`, `/index.xml` and friends. Every 15 minutes each one is polled, new
entries are full-text extracted and embedded, and old ones pruned. Resolution
happens *before* the source row is created, so a site with no feed never becomes
a broken entry you have to delete.

**Key phrases** are standing semantic queries. Each is embedded once and scored
against everything the listeners bring in, by meaning rather than keyword, so
"running models on your own hardware" finds an article that never uses those
words. Each phrase keeps its own results, so every recommendation can say which
phrase produced it, and a noisy phrase can be deleted on its own.

**Saving an article** also matches it against the pool, filed under "because you
saved X". That costs no API call, since the item's vector already exists.

### The floor was measured, not chosen

A phrase is short, so phrase → article is the **query-to-document** distribution,
not the document-to-document one recommendations use. There are three floors in
this codebase now and they are not interchangeable:

| Comparison | Floor | Why |
|---|---|---|
| query → document (search) | 0.22 | favours recall; you typed the query, you can judge |
| **phrase → document** | **0.32** | favours precision; nobody asked for this result |
| document → document | 0.45 | two long texts share prose vocabulary, so scores run hot |

0.32 came from scoring eight phrases against a real 202-article pool, four
on-topic and four deliberate controls:

| phrase | best match | found |
|---|---|---|
| retro computing / vintage OSes | 0.534 | homebrew Am29000 windowed OS ✓ |
| LLMs on your own hardware | 0.506 | running Kimi and GLM at scale ✓ |
| post-quantum cryptography | 0.388 | LLMs won't break symmetric crypto ✓ |
| SQLite internals | 0.349 | rebuilding Postgres for analytics ✓ |
| *Italian pasta recipes* | *0.338* | *a real food article in the pool* |
| beekeeping for beginners | 0.256 | a botany reading list |
| baroque church organ | 0.251 | "Altar II", matched on *altar* |
| premier league transfers | 0.223 | nothing |

The controls are the interesting part. Three of the four found weak but genuine
associations rather than nonsense, and the highest-scoring "control" hit was
*correct*. So the separation is strong-signal against weak-signal, not signal
against noise, which is exactly why the floor sits where it does.

### Details that matter

**Dismissal is per article, not per recommendation.** "Not interested" holds
however the piece is found next; otherwise a second phrase would resurface it an
hour later.

**An article matched by several origins appears once**, under its strongest, so
the count in the tab isn't a lie.

**Sweeps are idempotent.** `Recommendation` is keyed on `(user, candidate,
originKind, originId)`, two plain columns rather than nullable foreign keys,
because SQLite treats NULLs as distinct in a unique index and a nullable key
therefore cannot prevent a duplicate.

**Phrases carry a watermark**, so a poll costs what arrived rather than the whole
pool. Editing a phrase clears it and backfills against everything already held.

**An empty Discover distinguishes three cases**: no sources, no phrases, or
nothing close enough. The third is a real answer, not a fault.

## How it works

| Area | Where |
| --- | --- |
| Extraction | `src/lib/extract.ts`, fetch + Readability |
| Sanitising | `src/lib/sanitize.ts`, DOMPurify allowlist |
| Tidying | `src/lib/tidy.ts`, structural cleanup |
| Capture | `src/lib/capture.ts`, `src/app/api/capture` |
| Ordering | `src/lib/reorder.ts`, sparse float positions |
| Reader | `src/app/read/[id]`, `.prose-reader` in `globals.css` |
| Offline | `public/sw.js` |
| Classification | `src/lib/classify/`, rules, prompt, orchestration |
| LLM access | `src/lib/openrouter.ts`, one model, retried once on transient faults |

**Ordering** uses sparse floats. A move sets the item's position to the midpoint
of its new neighbours, so it writes one row rather than renumbering the list.
When a gap collapses below float precision the queue renormalises itself. There
is deliberately only one queue: starring marks and filters, it never reorders.

**Extraction runs detached** from the capture request, so sharing a link confirms
instantly and the text fills in a second later. A page that can't be extracted
stays in the list with the error, a retry, and a link to the original, so a
failed extraction never loses the save. Re-extracting an article that already
reads fine can't make it worse; on failure the existing copy is kept.

## Data

The server holds the only copy of your library, so `scripts/db-merge.mjs` is
**additive**. It inserts, never updates or deletes, matches users by email rather
than row id, and is idempotent. Nothing is lost unless you delete it in the app.
`scripts/db-backup.mjs` uses SQLite's backup API, so it's safe to run against a
live database.

```bash
npm run db:backup
npm run db:merge -- --from other.db --to prisma/dev.db --dry-run
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full procedure.

## Security

- Article HTML is rendered with `dangerouslySetInnerHTML`, so it's sanitised with
  DOMPurify under a strict tag/attribute allowlist **before** it's stored. 17 XSS
  payloads are covered by `tests/sanitize.test.mts`.
- `/api/capture` fetches user-supplied URLs server-side, so hosts are checked
  against private ranges (including cloud metadata at `169.254.169.254`, and
  IPv6 loopback and mapped addresses) on **every redirect hop**, including
  client-side `<meta refresh>` bounces. *Known limitation:* the check is on the
  hostname, not the resolved address, so a DNS name deliberately pointed at
  `127.0.0.1` would not be caught.
- Capture tokens are stored as SHA-256 hashes; the plaintext is shown once.
- Cookie-authenticated capture is same-origin only. Cross-origin callers must use
  a bearer token, which a browser never attaches automatically.

## Scripts

```bash
npm run dev          # dev server
npm run build        # production build
npm test             # sanitize, url, tidy, classify, search, graph, phrases, feeds, env, security, db-merge
npm run lint
npm run db:backup    # timestamped, keeps the last 20
npm run db:merge     # additive merge between two databases
npm run icons        # regenerate app icons from scripts/make-icons.py
npm run search:backfill        # index existing items (--index-only skips embedding)
```

## Licence

[MIT](LICENSE). Use it, change it, host it, sell it. Keep the copyright notice,
and it comes with no warranty.

It started as a personal project and the licence said so, which rather undercut a
README written for other people to read. If it's useful to you, take it.

Every dependency is permissive too (MIT, Apache-2.0, ISC, or MPL), so there's
nothing here that stops you.

**One thing that isn't covered by any of this:** the articles rightread saves
belong to whoever wrote them. The app strips a page down for your own reading,
which is a very different thing from republishing it. If you run an instance for
other people, that's your call to think about, not something a licence on this
code settles.
