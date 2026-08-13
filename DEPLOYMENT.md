# Deployment Guide — www.rightread.net

Same Hetzner box and the same pattern as `uk-property-analyzer` (rightdata.uk):
Docker container behind Caddy, which terminates TLS and gets certificates from
Let's Encrypt automatically.

## Server details
- **Provider:** Hetzner Cloud
- **IP:** `<SERVER_IP>`
- **OS:** Ubuntu 24.04 LTS
- **User:** `root` (password auth — see the security note at the bottom)
- **App directory:** `/opt/rightread`
- **Live URL:** https://www.rightread.net

## Port map on this host

| Port | What |
| --- | --- |
| 80 / 443 | Caddy |
| 3000 | uk-property-analyzer — rightdata.uk |
| 3001 | Caddy listener fronting rightmind + scribe |
| 3010 | rightmind container |
| 3020 | rightscribe |
| 4416 | pot-provider |
| **3003** | **rightread** |

Verify with `ss -tlnp` before assuming a port is free.

## Why HTTPS is mandatory here

Not a hardening step — the app's main features don't exist without it. Chrome
gates all of these on a secure origin and fails **silently** when it isn't one:

- the **share target** (rightread never appears in the Android share sheet)
- **WebAPK install** — "Add to Home screen" only creates a bookmark shortcut,
  which you can spot by the Chrome badge on the icon
- the **service worker**, so no offline reading

This is the same class of problem `uk-property-analyzer` documents under
"Login not working": a `Secure` cookie that only works over HTTPS.

## First-time setup

**1. DNS** — both hostnames must resolve to the box before Caddy can get a
certificate (Let's Encrypt connects to whatever the name resolves to):

```
rightread.net.      A  <SERVER_IP>
www.rightread.net.  A  <SERVER_IP>
```

At Gandi, delete any Web Forwarding on `www` first — it creates a CNAME to
`webredir.vip.gandi.net` that overrides the A record. Leave the MX records
alone.

**2. Caddy** — append the block in this repo's `Caddyfile` to
`/etc/caddy/Caddyfile` (keep the existing `rightdata.uk` block), then:

```bash
systemctl restart caddy
systemctl status caddy --no-pager
```

Caddy requests the certificate on the first request to the new hostname.

**3. Environment** — create `/opt/rightread/.env.prod`:

```bash
AUTH_SECRET="<openssl rand -hex 32>"       # NOT the same as any other app's
AUTH_URL="https://www.rightread.net"
AUTH_TRUST_HOST=true
AUTH_RESEND_KEY="<resend key>"
EMAIL_FROM="rightread <noreply@send.example.com>"   # MUST be a verified domain
DATABASE_URL="file:/app/data/production.db"
RIGHTREAD_ALLOWED_EMAILS="you@example.com,someone@else.com"
OPENROUTER_API_KEY="<openrouter key>"
OPENROUTER_MODEL="openai/gpt-5.6-luna"
```

`EMAIL_FROM` must use a domain **verified at resend.com/domains**, and this
only starts to matter once there is more than one user. On the shared
`onboarding@resend.dev` sender a Resend account is in testing mode and will
deliver *only to the account owner's own address*, rejecting everyone else with
a 403. So the box appears to work perfectly for whoever owns the Resend account
and fails for every other person on the allow list — the one failure the
account owner cannot reproduce.

Verify a **subdomain** (`send.rightread.net`), never the apex. A domain may
carry only one SPF record, and `rightread.net` already has one for Gandi mail;
verifying the apex means hand-merging it, and a mistake there breaks ordinary
email for the domain. A subdomain gets its own SPF and DKIM and leaves the
existing mail setup alone.

`RIGHTREAD_ALLOWED_EMAILS` is the sign-in gate, and it is the one variable that
**must not** be forgotten here: leave it out and it reaches the container as an
empty string, which is read as "deny everyone" — the login page will refuse
every address, including yours, until it is set and the container restarted.
That is the deliberate direction to fail (a blank gate that admitted everyone
would be a silent, production-only hole), but it does mean adding or removing a
person is an edit to this file plus a redeploy. Check it took with:

```bash
docker-compose --env-file .env.prod exec app printenv RIGHTREAD_ALLOWED_EMAILS
```

`OPENROUTER_*` drives page classification (and, later, summaries). If the key is
absent the app still works — pages classify as `other` and nothing errors.

`AUTH_URL` matters. With it set, `src/app/api/auth/[...nextauth]/route.ts`
stops deriving the host from request headers. That derivation exists only to
make LAN testing work and trusts a client-supplied `Host` — fine on your own
network, not something to leave enabled on a public box.

**4. Deploy** (see below).

## Deploying an update

> **Ask for the SSH password before connecting.** The server uses password
> authentication and SSH hangs silently without it.

```bash
cd /opt/rightread
git pull
docker-compose --env-file .env.prod up -d --build
```

### Known quirk: docker-compose v1 on Ubuntu 24.04

The box has `docker-compose` v1.29.2, which cannot recreate existing containers
against a newer Docker Engine — it fails with `KeyError: 'ContainerConfig'`.
Remove the old container first:

```bash
docker rm -f $(docker ps -aq -f name=rightread) 2>/dev/null || true
docker-compose --env-file .env.prod up -d --build
```

## Data — nothing is lost unless you delete it

SQLite lives in the named volume `rightread_sqlite_data`, mounted at
`/app/data/production.db`.

> **Do not copy uk-property-analyzer's database step.** That project uploads
> local `prisma/dev.db` over the server's copy on every deploy, because its
> local database is the source of truth. rightread is the opposite: you save
> articles *on the server*, from your phone. A file copy in either direction
> silently destroys whichever side it overwrites.

Use `scripts/db-merge.mjs` instead. It inserts rows and never updates or
deletes them, so:

- rows only on the server stay
- rows only in the imported file get added
- where both have the same item, **the server wins** — it is the live side
- running it twice does nothing the second time

Users are matched **by email, not row id**, because signing in on the server
creates a `User` row with a different cuid for the same person. Items are
remapped onto the server's user id; without that they would all be orphaned.

### Seeding the server from your local database

```bash
# 1. Local: back up, then copy the database up
npm run db:backup
node scripts/remote.mjs --put prisma/dev.db /opt/rightread/incoming.db
# On Git Bash prefix with MSYS_NO_PATHCONV=1, or it rewrites the remote
# absolute path into a Windows one before Node ever sees it.

# 2. Server: back up the live database FIRST
docker exec $(docker ps -q -f name=rightread) node scripts/db-backup.mjs

# 3. Server: preview, then apply
docker cp /opt/rightread/incoming.db $(docker ps -q -f name=rightread):/tmp/incoming.db
docker exec $(docker ps -q -f name=rightread) \
  node scripts/db-merge.mjs --from /tmp/incoming.db --to /app/data/production.db --dry-run
docker exec $(docker ps -q -f name=rightread) \
  node scripts/db-merge.mjs --from /tmp/incoming.db --to /app/data/production.db
```

`--dry-run` reports exactly what would be added and writes nothing. Always run
it first.

Both databases must be on the same Prisma schema. Columns the target lacks are
reported and ignored rather than crashing the merge; the whole thing runs in one
transaction and rolls back on any error.

### Routine backups

```bash
docker exec $(docker ps -q -f name=rightread) node scripts/db-backup.mjs
```

Writes a timestamped copy to `/app/data/backups/`, keeping the latest 20. It
uses SQLite's backup API rather than `cp`, so it is safe against a database the
app is actively writing to — copying a live SQLite file can catch a torn page
or miss the `-wal` contents. Worth a cron entry.

To pull a backup down:

```bash
docker cp $(docker ps -q -f name=rightread):/app/data/backups ./server-backups
```

### Does the volume survive a redeploy?

Yes. Named volumes outlive `docker rm` and `docker-compose up --build`; only
`docker volume rm` or `docker-compose down -v` destroy them. The `docker rm -f`
in the v1 workaround above is safe. Back up before deploying anyway — the cost
is a second and the alternative is your reading library.

Count saved items:

```bash
docker exec $(docker ps -q -f name=rightread) \
  node -e "const{DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/app/data/production.db').prepare('SELECT count(*) c FROM Item').get())"
```

## After deploying

1. Visit https://www.rightread.net and sign in — confirm the magic-link email
   arrives and its link points at `www.rightread.net`, not localhost.
2. On Android Chrome, menu → it should now offer **Install app**, not just
   "Add to Home screen". Install it.
3. Share a link from any app — rightread should appear in the sheet.
4. Update the browser extension's server address to
   `https://www.rightread.net` and issue a fresh capture token.

If the share sheet still doesn't list it, delete the old home-screen icon
first: a shortcut added over HTTP never becomes a WebAPK.

## Troubleshooting

```bash
docker logs $(docker ps -q -f name=rightread) --tail 100
journalctl -u caddy -n 50 --no-pager
curl -s -o /dev/null -w "%{http_code}" http://localhost:3003
```

## Security note

The server accepts root logins by password over SSH, which is scanned
continuously on a public IP. Worth moving to key-based auth with
`PermitRootLogin prohibit-password`.

Real host details (IP, credentials location) are in `DEPLOYMENT.local.md`,
which is gitignored and stays on your machine.
