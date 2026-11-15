# End-to-end tests

The app in a real browser, used the way it is used on a phone, before a deploy.
`npm test` checks the logic; this checks that the built app, its service worker and a
browser agree with each other. It exists because on 2026-11-13 the reader showed a cached
"couldn't be turned into a reader view" page for an article that had since been fixed,
and no check had run the app in a browser.

## Run it

Needs Docker and nothing else. There is no Node on the server, so run the script, not npm.

```sh
tests/e2e/run.sh                              # everything, against rightread_app:latest
tests/e2e/run.sh --image rightread_app:new    # against another image
tests/e2e/run.sh specs/offline.spec.mjs       # one file
tests/e2e/run.sh -g "blocked"                 # tests whose title matches
```

It exits 0 only if every test passed, and takes about a minute. On a failure it keeps a
folder under `/tmp` and prints its path: the app's log, and a screenshot and a Playwright
trace for each failed test.

The first run (and the first after the Playwright version changes) installs one npm
package into `tests/e2e/node_modules`, which is the only step that uses the internet.

## What it starts

All of it is removed when the script ends, however it ends.

- **A Docker network with no route to the outside** (`--internal`). Nothing in a test
  run can reach a real site, TinyFish or OpenRouter, even by mistake.
- **A fixture server** (`fixtures/server.mjs`) on that network. It answers as:
  - `news.e2e.test`: invented articles. A page can be told to fail, to hang until
    released, or to answer normally, so a test can break a site and then mend it;
  - `forum.e2e.test`: a forum that answers every request with a Cloudflare-style 403;
  - `api.fetch.tinyfish.ai`: a fake TinyFish that returns a three-page thread in the
    shape recorded from the real API on 2026-11-13;
  - `openrouter.ai`: always 503, so classification and embeddings fail soft.
- **One throwaway copy of the app image**, with its database in a file inside the
  container. No port is published. It never sees the production volume or `.env.prod`.
- **Chromium** from Microsoft's Playwright image (pinned to the same version as the npm
  package), emulating a Pixel 7: phone viewport, touch, mobile user agent. It shares the
  app container's network, so it opens `http://127.0.0.1:3000`, an address where the
  browser registers the service worker.

**No production code is changed to make this possible.** The app's guard against
fetching local addresses looks at the host name, and the fixtures have ordinary names.
The app reaches the fake TinyFish at TinyFish's real address because, on this network
only, that name resolves to the fixture server; it trusts the fixture's certificate
because the copy is started with `NODE_EXTRA_CA_CERTS`, a standard Node setting, naming a
certificate authority made for the run and deleted after it.

**Sign-in** needs no email and no back door. The app keeps sessions in the database, so
`lib/seed.mjs` writes a user and a session row into the throwaway database and the
browser is given the matching cookie.

## What is tested

| File | What a pass shows |
|---|---|
| `auth.spec.mjs` | Signed out: the queue and a share go to sign-in (the share keeps its link), the API answers 401. Signed in: the queue loads. The service worker installs and takes control. |
| `capture.spec.mjs` | A link opened through the manifest's share target is saved, extracted and readable. The link is found inside shared text. A second share says "Already saved". Pasting into the box saves at once; typing a link offers Save; typing words searches. Saves work while OpenRouter fails. |
| `stale-reader.spec.mjs` | **The 2026-11-13 fault.** A failed reader page that the worker cached shows the article once the item is fixed: opened fresh, and opened by tapping the row. A reader left open while extracting turns into the article. Re-saving a failed item shows it as extracting. An open queue shows a share-target save without being touched. |
| `blocked.spec.mjs` | A site behind a bot wall is fetched through the fallback, all three pages into one item, with the log line RELEASE reads. A refused fallback ends as "Blocked". An ordinary failure is never sent to the fallback. |
| `offline.spec.mjs` | With the network off: the queue loads, an article read earlier opens, an article that was only saved opens, an unvisited page shows "You're offline". A star and a Done made offline reach the server after reconnecting. |
| `notifications.spec.mjs` | Settings shows the section; the Group shares switch is saved on the server; switching the device on with no push service says so and stays off; the page holds no private key and asks no permission on load. The service worker turns a push message into the right notification. |

## What a pass does not show

- **Chromium emulating a phone is not the installed Android app.** There is no home
  screen install, no system share sheet (the tests open the URL the share sheet would),
  no Android back button, no real foreground and background. Two tests fire the
  "app came to the front" event by hand; they say so.
- **"Offline" is the browser's own switch**, which fails requests at once. Aeroplane
  wi-fi that accepts a request and never answers is covered by the unit tests instead.
- **No notification is delivered.** The network is closed, so the browser cannot
  subscribe and nothing is sent to Google. The push test hands the worker a message
  directly. Subscribing, the test button and a notification arriving need a phone.
- **TinyFish is a fake.** It returns the shape recorded once. If the real service
  changes, only the canary below notices.
- **Summaries, search and recommendations are not covered**: they need a working model.
- Sign-in by emailed link is not exercised (there is no mail key); the session is seeded.

## The canary: one real save through TinyFish

Separate, opt-in, and **paid**. It saves one blocked multi-page thread through the real
TinyFish API on a throwaway copy of the image and passes only if the app's log line says
`outcome=ok stop=page_total` with `pages` equal to `total` (and more than one), and the
stored article has no "cut short" note.

```sh
TINYFISH_API_KEY=... tests/e2e/canary.sh [--image NAME] <thread-url>
```

It needs the user's OK in the session that runs it (see "Paid checks" in `AGENTS.md`).
The key is read from the environment and is never written to a file or printed; the URL
is an argument and is not printed. Nothing runs the canary automatically.

`tests/e2e/canary.sh --self-test` runs the same steps and checks against the fake
TinyFish, with no key and no cost, to show that the script itself works.

## Adding a test

Tests are plain JavaScript (`specs/*.spec.mjs`), run one at a time against one database,
so give every test its own URL. `specs/support.mjs` has the helpers: `share()` saves the
way Android does, `waitForItem()` asks the server (past the service worker) what state an
item is in, and `setMode()` / `release()` change how a fixture page behaves. Fixture text
must be invented: this repository is public.
