#!/usr/bin/env bash
#
# rightread end-to-end tests: the app in a real browser, the way it is used
# on a phone, before a deploy.
#
#   tests/e2e/run.sh [--image NAME] [playwright arguments...]
#
#   tests/e2e/run.sh                          the whole suite against rightread_app:latest
#   tests/e2e/run.sh --image rightread_app:x  against another image
#   tests/e2e/run.sh specs/offline.spec.mjs   one file
#   tests/e2e/run.sh -g "stale"               tests whose title matches
#
# Exits 0 only if every test passed. Needs Docker and nothing else on the host.
#
# What it starts, and removes again whatever happens:
#   - a Docker network of its own with NO route to the outside (--internal);
#   - a fixture server on that network, answering as the sites the tests save
#     and as api.fetch.tinyfish.ai and openrouter.ai (see fixtures/server.mjs);
#   - one throwaway copy of the app image, with a throwaway database inside
#     the container. No port is published. It never sees the production
#     volume or .env.prod;
#   - the Playwright container, sharing the app container's network, so the
#     browser opens http://127.0.0.1:3000.
#
# The only step that uses the internet is installing Playwright's npm package
# into tests/e2e/node_modules, the first time or after its version changes.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

IMAGE="${RR_E2E_IMAGE:-rightread_app:latest}"
if [ "${1:-}" = "--image" ]; then
  IMAGE="${2:?--image needs a name}"
  shift 2
fi

RUN="rr-e2e-$$"
NET="$RUN-net"
APP="$RUN-app"
FIX="$RUN-fixtures"
WORK="$(mktemp -d /tmp/rightread-e2e.XXXXXX)"
OUT="$WORK/out"
mkdir -p "$OUT"
LOG_PID=""
STATUS=1

cleanup() {
  [ -n "$LOG_PID" ] && kill "$LOG_PID" 2>/dev/null || true
  # Only ever the containers and network this run created, by their exact names.
  docker rm -f "$APP" "$FIX" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # The certificate key, the session token and the VAPID keys are for this run only.
  rm -rf "$WORK/tls" "$WORK/app.env"
  if [ "$STATUS" -eq 0 ]; then
    rm -rf "$WORK"
  else
    echo
    echo "Kept for diagnosis: $OUT"
    echo "  app.log       the app's log for this run"
    echo "  fixtures.log  the fixture server's log"
    echo "  results/      a trace and a screenshot for each failed test"
    echo "  (open a trace with: npx playwright show-trace <trace.zip>)"
  fi
}
trap cleanup EXIT

docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "No such image: $IMAGE (build it first, or pass --image)" >&2
  exit 2
}

# ── 1. Playwright's npm package (the browsers are in the image) ──────
installed="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$HERE/node_modules/@playwright/test/package.json" 2>/dev/null || true)"
if [ "$installed" != "$PW_VERSION" ]; then
  say "Installing @playwright/test $PW_VERSION into tests/e2e/node_modules (uses the internet, once)"
  docker run --rm -v "$HERE":/e2e -w /e2e "$PW_IMAGE" npm ci --no-audit --no-fund
fi

# ── 2. A certificate authority for this run ──────────────────────────
say "Making a test certificate"
make_certs

# ── 3. Environment for the app copy ──────────────────────────────────
SESSION_TOKEN="$(random_hex)"
{
  echo "DATABASE_URL=file:/tmp/e2e.db"
  echo "AUTH_SECRET=$(random_hex)"
  echo "AUTH_URL=http://127.0.0.1:3000"
  echo "AUTH_TRUST_HOST=true"
  echo "RIGHTREAD_ALLOWED_EMAILS=reader@e2e.test"
  # Dummies. On this network the two names resolve to the fixture server, and
  # there is no route anywhere else.
  echo "OPENROUTER_API_KEY=e2e-dummy-not-a-key"
  echo "TINYFISH_API_KEY=e2e-dummy-not-a-key"
  echo "NODE_EXTRA_CA_CERTS=/e2e-ca.pem"
  echo "VAPID_SUBJECT=https://e2e.test"
  # A fresh pair, so Settings shows the Notifications section. Nothing is
  # ever sent with it: there is no push service to send to.
  docker run --rm "$IMAGE" node scripts/vapid-keys.mjs | grep '^VAPID_'
} > "$WORK/app.env"
chmod 600 "$WORK/app.env"

# ── 4. The network, the fixtures, the app ────────────────────────────
say "Starting the fixture server and a throwaway copy of $IMAGE"
start_fixtures

docker run -d --name "$APP" --network "$NET" --env-file "$WORK/app.env" \
  -v "$HERE":/e2e:ro -v "$WORK/tls/ca.pem":/e2e-ca.pem:ro \
  "$IMAGE" >/dev/null

wait_for_app "$OUT/app.log"

# ── 5. Sign the test user in ─────────────────────────────────────────
seed_session "$SESSION_TOKEN"

# ── 6. The tests ─────────────────────────────────────────────────────
say "Running the tests in Chromium, as a phone"
set +e
docker run --rm --network "container:$APP" --ipc=host \
  -v "$HERE":/e2e:ro -v "$OUT":/out -w /e2e \
  -e E2E_SESSION_TOKEN="$SESSION_TOKEN" -e E2E_OUT=/out -e CI=1 \
  "$PW_IMAGE" npx playwright test "$@"
STATUS=$?
set -e

docker logs "$FIX" > "$OUT/fixtures.log" 2>&1 || true

if [ "$STATUS" -eq 0 ]; then
  say "PASSED"
else
  say "FAILED (exit $STATUS)"
fi
exit "$STATUS"
