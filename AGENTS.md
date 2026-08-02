<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# rightread

Read-later. Capture a link from anywhere, extract the article text, read it clean and offline.

No AI layer by design — capture, extract, read, prioritize. That's it.

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
