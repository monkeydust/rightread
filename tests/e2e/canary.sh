#!/usr/bin/env bash
#
# Canary: ONE real save of a blocked, multi-page thread through the REAL
# TinyFish API, on a throwaway copy of the app image.
#
#   TINYFISH_API_KEY=... tests/e2e/canary.sh [--image NAME] <thread-url>
#
# THIS SPENDS MONEY AND CONTACTS A REAL SITE THROUGH A THIRD PARTY. It needs
# the user's OK, given in the session that runs it (AGENTS.md, "Paid checks").
# It is not part of run.sh and nothing runs it automatically.
#
# The key comes from the environment of whoever runs this. It is never
# written to a file, printed, or put on a command line. The URL is an
# argument and is not printed either.
#
# It passes only if the app's own log line for the save says
#   outcome=ok  stop=page_total  pages == total  and total > 1
# and the stored article carries no "cut short" note.
#
#   tests/e2e/canary.sh --self-test
# runs the same steps and the same checks against the suite's FAKE TinyFish,
# with no key, no cost and no outside network, to show the script itself works.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

IMAGE="${RR_E2E_IMAGE:-rightread_app:latest}"
SELF_TEST=""
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?--image needs a name}"; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) URL="$1"; shift ;;
  esac
done

if [ -n "$SELF_TEST" ]; then
  # A URL may be given to try another fixture, e.g. .../thread/refused.
  URL="${URL:-https://forum.e2e.test/thread/tides}"
elif [ -z "$URL" ] || [ -z "${TINYFISH_API_KEY:-}" ]; then
  sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
fi

RUN="rr-canary-$$"
NET="$RUN-net"
APP="$RUN-app"
FIX="$RUN-fixtures"
WORK="$(mktemp -d /tmp/rightread-canary.XXXXXX)"
LOG="$WORK/app.log"
LOG_PID=""

cleanup() {
  [ -n "$LOG_PID" ] && kill "$LOG_PID" 2>/dev/null || true
  docker rm -f "$APP" "$FIX" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "No such image: $IMAGE" >&2; exit 2; }

SESSION_TOKEN="$(random_hex)"
COMMON_ENV=(
  -e DATABASE_URL=file:/tmp/e2e.db
  -e "AUTH_SECRET=$(random_hex)"
  -e AUTH_URL=http://127.0.0.1:3000
  -e AUTH_TRUST_HOST=true
  -e RIGHTREAD_ALLOWED_EMAILS=reader@e2e.test
)

if [ -n "$SELF_TEST" ]; then
  say "Self-test: fake TinyFish, closed network, no key, no cost"
  make_certs
  start_fixtures
  docker run -d --name "$APP" --network "$NET" "${COMMON_ENV[@]}" \
    -e OPENROUTER_API_KEY=e2e-dummy-not-a-key -e TINYFISH_API_KEY=e2e-dummy-not-a-key \
    -e NODE_EXTRA_CA_CERTS=/e2e-ca.pem \
    -v "$HERE":/e2e:ro -v "$WORK/tls/ca.pem":/e2e-ca.pem:ro "$IMAGE" >/dev/null
else
  say "Canary: one REAL save through TinyFish (paid). Image: $IMAGE"
  # The default Docker network, because this one has to reach the internet.
  # No port is published. `-e TINYFISH_API_KEY` with no value passes the
  # variable through from this shell without it appearing in the command.
  # OpenRouter is left without a key, so classification and embeddings make
  # no call at all.
  docker run -d --name "$APP" "${COMMON_ENV[@]}" -e TINYFISH_API_KEY \
    -v "$HERE":/e2e:ro "$IMAGE" >/dev/null
fi

wait_for_app "$LOG"
seed_session "$SESSION_TOKEN" >/dev/null

say "Saving the thread and waiting for it (up to 8 minutes)"
RESULT="$(docker exec -e E2E_SESSION_TOKEN="$SESSION_TOKEN" "$APP" node /e2e/lib/canary-save.mjs "$URL")"
sleep 1
LINE="$(grep -F '[rightread] fetch fallback (tinyfish)' "$LOG" | tail -1 || true)"

echo "stored:   $RESULT"
echo "log line: ${LINE:-(none: the fallback was never used)}"

field() { printf '%s' "$LINE" | sed -n "s/.* $1=\([^ ]*\).*/\1/p"; }
PAGES="$(field pages)"
TOTAL="$(field total)"
STOP="$(field stop)"
OUTCOME="$(field outcome)"

fail=0
need() {
  if [ "$2" = "yes" ]; then echo "  ok    $1"; else echo "  FAIL  $1"; fail=1; fi
}
yes_if() { if "$@"; then echo yes; else echo no; fi; }

need "the save was accepted"                       "$(yes_if grep -q '"saved":true' <<<"$RESULT")"
need "the extraction finished as ok"               "$(yes_if grep -q '"extractStatus":"ok"' <<<"$RESULT")"
need "the site was blocked and the fallback used"  "$(yes_if test -n "$LINE")"
need "outcome=ok"                                  "$(yes_if test "$OUTCOME" = "ok")"
need "stop=page_total"                             "$(yes_if test "$STOP" = "page_total")"
need "the thread has more than one page (total=${TOTAL:-?})" "$(yes_if test "${TOTAL:-0}" -gt 1 2>/dev/null)"
need "every page was fetched (pages=${PAGES:-?} total=${TOTAL:-?})" "$(yes_if test -n "$PAGES" -a "$PAGES" = "$TOTAL")"
need "no cut-short note in the stored article"     "$(yes_if grep -q '"cutShort":false' <<<"$RESULT")"

if [ "$fail" -eq 0 ]; then say "CANARY PASSED"; else say "CANARY FAILED"; fi
exit "$fail"
