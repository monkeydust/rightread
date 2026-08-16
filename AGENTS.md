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

## Groups
A shared shelf (`src/lib/groups/`). Every other model is owned by one user and
read with `where: { userId }`, checked inline at each call site. Groups are the
one exception — visibility is by **membership** — so all four group models are
read only through `src/lib/groups/access.ts`. Nothing else queries them
directly, and a share id is never trusted alone: `resolveShare` checks
membership of the group the share belongs to, or a bare id becomes a handle
into another group's shelf. Refusals are 404, never 403.

Two decisions worth not undoing:

- **A `GroupShare` carries its own snapshot** of the link rather than pointing
  at the sharer's `Item`. The shelf then survives the sharer deleting or
  archiving their copy, and Save is just `captureUrl()` — so the saved row is
  an ordinary Item and ordering, starring, search and the graph need no
  group-awareness at all. `sharedByUserId` is nullable with `SetNull`, against
  the cascade-everywhere convention, because a share is on a shelf other people
  read: closing your account must not erase your contributions from it.
- **No `contentHtml` crosses a user boundary.** `applyProvidedContent()` stores
  HTML the sharer's own browser supplied, so serving it to a group republishes
  something they never chose to, and turns a sanitizer bypass from self-XSS
  into cross-account XSS. The shelf is a metadata card; reading happens in your
  own copy after Save. The cost is that a paywalled article a sharer captured
  from their own session may not extract for anyone else.

Invites are redeemed in `events.signIn` (not the `signIn` callback — the
account does not exist yet there). An invite is not permission to sign in:
`RIGHTREAD_ALLOWED_EMAILS` remains the only gate, so an invite to an address
not on it stays dormant, and the UI says so rather than implying otherwise.
