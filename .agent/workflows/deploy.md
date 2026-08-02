---
description: How to deploy or redeploy to Hetzner (www.rightread.net)
---

# Deploy to Hetzner

**ALWAYS read `DEPLOYMENT.md` at the root of the project before doing anything
deployment-related.** It has the server details, the port map, the redeploy
sequence and the known quirks.

## Steps

1. Read `DEPLOYMENT.md` in full.
2. **Ask the user for the SSH password.** The server uses password auth and SSH
   hangs silently without it.
3. SSH in: `ssh root@<SERVER_IP>`
4. Follow "Deploying an update" exactly — note the docker-compose v1
   `ContainerConfig` workaround (remove the container before `up`).
5. Verify: `curl -s https://www.rightread.net -o /dev/null -w "%{http_code}"`

## Do not copy uk-property-analyzer's database step

That project re-uploads local `prisma/dev.db` to the server after each deploy,
because local is its source of truth. **rightread is the opposite** — the
server holds the only copy of the reading library. Uploading a local database
would destroy it. Back up from the server instead; see "Data" in
`DEPLOYMENT.md`.

## First deploy only

DNS record and Caddy block must exist before the first request, or certificate
issuance fails. See "First-time setup" in `DEPLOYMENT.md`.
