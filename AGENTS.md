<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# rightread

Read-later. Capture a link from anywhere, extract the article text, read it clean and offline.

The core loop is deliberately manual — capture, extract, read, prioritize.
AI sits at the edges, never in the way: page-kind classification
(`src/lib/classify/`), semantic search over stored embeddings
(`src/lib/search/`), and source-curated recommendations (`src/lib/sources/`).
All of it is fail-soft by contract: an LLM or embedding failure must never
break a capture, a search, or a page render.

## Capture paths (all hit `POST /api/capture`)
- **PWA share target** — installed on Android, appears in the system share sheet.
- **Browser extension** — `extension/`, MV3, loads unpacked in Edge and Chrome.
- **Paste box** — in the app itself.

Extension and Shortcut-style clients authenticate with a `CaptureToken` bearer token;
the web app authenticates with the Auth.js session cookie.

## Extraction
`src/lib/extract.ts` — fetch the URL, run `@mozilla/readability` over a jsdom
document, sanitize the result to an allowlist of tags/attributes, store the HTML
in `Item.contentHtml`. Sanitization is not optional: that HTML is rendered with
`dangerouslySetInnerHTML` in the reader.

## Ordering
`Item.position` is a float. Moving an item between two neighbours sets its
position to their midpoint, so a reorder writes one row, not the whole list.
Pinned items sort above unpinned.

## Recommendations
Embedding-similar articles drawn **only** from RSS/Atom feeds the user added
in settings (`Source` → `Candidate` in the schema; `src/lib/sources/`). A
15-minute in-process poller (started by `src/instrumentation.ts`) admits new
feed entries as candidates, full-text-extracts and embeds them, and prunes
old ones. Candidates are deliberately not Items — the library is never
polluted by machine-fetched articles, and saving a recommendation goes
through the normal capture flow. The reader shows the panel only when
something clears the measured similarity floor shared with semantic search.

## Thread summaries
The one place a model writes prose the reader sees, and it is confined to
`conversation`-kind pages, where a summary of a 200-comment discussion is a
service rather than a substitute for reading. Rules:

- **On demand only.** Nothing on the capture path writes a summary. The button
  in the reader (`ThreadSummary`) calls `POST /api/items/[id]/summary`, which
  is not fail-soft: the user pressed a button, so every failure is a message.
- **Refresh means re-fetch.** A summary of last week's copy says nothing about
  what happened since. `refreshSummary` (`src/lib/summarize/refresh.ts`)
  re-fetches the thread, replaces the stored copy through `persistArticle`,
  and only then summarises — with the previous summary in hand, so the model
  writes `sinceLast`.
- **History is append-only.** `ItemSummary` gets a row per generation, each
  recording what it summarised (`fetchedAt`, `commentCount`, `newComments`).
  The sequence is the record of how the discussion moved; never overwrite it.
- **Threads are read as structure where possible.** `src/lib/threads/` has one
  adapter per site (HN today, via the Algolia API); `runExtraction` uses it at
  capture too, so an HN item is a nested thread rather than Readability's
  guess. Per-comment timestamps make "new since last time" a fact. Sites
  without an adapter take the page path: ordinary re-extraction, no comment
  count. Reddit blocks server fetches entirely and stays on the paste path.

## Offline
The app is meant to be read on a plane, so offline is a first-class mode, not a
degraded one. Three rules, each of which was learned the hard way:

- **`VERSION` and `DATA_VERSION` in `public/sw.js` are not the same thing.**
  `VERSION` covers the shell and static assets and must be bumped on any markup
  or styling change, or cached HTML ends up pointing at deleted chunks.
  `DATA_VERSION` covers downloaded articles and must be bumped **only** if what
  is stored per article changes shape. They used to share one constant, which
  meant every deploy deleted every reader's offline library — a CSS tweak
  throwing away the megabyte someone downloaded precisely so they could read it
  without a network.
- **A cached article page belongs to a build.** It is the HTML of the build
  it was saved under and names that build's chunks, so served after a deploy
  it runs code the server has replaced — every fix shipped to the reader was
  invisible on any article already opened once. The worker reads Next's
  build id (`"b":"…"`) out of each cached copy and knows the current one from
  the shell it installed (and from any fresh page it stores): a copy from
  this build is served at once, a copy from an older build goes network-first
  and is only the offline fallback, and activation re-fetches stale ones in
  the background. Do not "simplify" the article branches back to plain
  cache-first.
- **Every network call must be able to give up.** Aeroplane wi-fi associates
  without routing, so `navigator.onLine` is true and requests are accepted and
  then black-holed: a bare `fetch` neither resolves nor rejects, and anything
  awaiting it wedges for ever. Use `timedFetch` in the worker and `netFetch`
  from `src/lib/connectivity.ts` on the client; never a bare `fetch`.
- **Offline is a state, not an error.** Changes are queued in
  `src/lib/outbox.ts` and replayed on reconnect, so a star or a Done applies at
  once and lands later. Only *absolute, idempotent* operations may be queued —
  `starred`, `status`, `kind`, `progress`, delete, and captured URLs. Reorder
  is `{move: "up"}`, which is relative and resolved server-side against live
  position floats, so it cannot be replayed and stays online-only.

Reachability is exposed by `src/lib/connectivity.ts` (the browser flag plus what
actually happened to recent requests) and shown as a small dot in the header.
Search degrades offline to a title-and-excerpt filter over the list in memory,
and says so — article bodies never reach the client.

## Groups
A shared shelf (`src/lib/groups/`). Every other model is owned by one user and
read with `where: { userId }`, checked inline at each call site. Groups are the
one exception — visibility is by **membership** — so all four group models are
read only through `src/lib/groups/access.ts`. Nothing else queries them
directly, and a share id is never trusted alone: `resolveShare` checks
membership of the group the share belongs to, or a bare id becomes a handle
into another group's shelf. Refusals are 404, never 403.

**A share must already be in the sharer's library.** There is no paste box on
a group page: sharing starts from a row in the queue or archive, or from the
reader. `shareIntoGroup` enforces it (`NotInLibrary`) rather than leaving it to
the UI, so a direct API call cannot put an arbitrary URL on someone's shelf. A
shelf is meant to be things people actually chose to read.

Two further decisions worth not undoing:

- **A `GroupShare` carries its own snapshot** of the link rather than pointing
  at the sharer's `Item`. The shelf then survives the sharer deleting or
  archiving their copy, and Save is just `captureUrl()` — so the saved row is
  an ordinary Item and ordering, starring, search and the graph need no
  group-awareness at all. `sharedByUserId` is nullable with `SetNull`, against
  the cascade-everywhere convention, because a share is on a shelf other people
  read: closing your account must not erase your contributions from it.
- **The shelf never renders another user's markup.** A `GroupShare` holds no
  `contentHtml`; browsing a group shows cards. On Save, though, the new item
  seeds itself from the sharer's extracted copy
  (`adoptSharedArticle()` in `lib/capture.ts`), because
  `applyProvidedContent()` means the sharer's text can be a paywalled page no
  other server fetch can reproduce — so without it the articles most worth
  sharing arrive broken. It is re-sanitized on the way in, against the current
  allow list, and it is a seed: the recipient's own extraction overwrites it
  when it succeeds and preserves it when it fails.

Invites are redeemed in `events.signIn` (not the `signIn` callback — the
account does not exist yet there). An invite is not permission to sign in:
`RIGHTREAD_ALLOWED_EMAILS` remains the only gate, so an invite to an address
not on it stays dormant, and the UI says so rather than implying otherwise.
