# Shared by run.sh and canary.sh. Sourced, not run.
#
# Expects: HERE (this folder's parent, tests/e2e), WORK (a temp folder for
# this run), and the names NET, APP, FIX. Everything created here is removed
# by the caller's cleanup, by those exact names.

PW_VERSION="1.65.1"
PW_IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

say() { printf '\n== %s\n' "$*"; }

random_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# A certificate authority for this run, and one certificate for the fixture
# server under every name it answers to. The app trusts it because it is
# started with NODE_EXTRA_CA_CERTS naming the CA: an ordinary Node setting,
# not a change to the app. The keys are deleted when the run ends.
make_certs() {
  mkdir -p "$WORK/tls"
  docker run --rm -v "$WORK/tls":/tls -w /tls "$PW_IMAGE" sh -c '
    set -e
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=rightread e2e test CA" \
      -keyout ca.key -out ca.pem >/dev/null 2>&1
    openssl req -newkey rsa:2048 -nodes -subj "/CN=rightread e2e fixtures" \
      -keyout server.key -out server.csr >/dev/null 2>&1
    printf "subjectAltName=DNS:api.fetch.tinyfish.ai,DNS:openrouter.ai,DNS:forum.e2e.test,DNS:news.e2e.test\n" > san.cnf
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
      -extfile san.cnf -out server.pem >/dev/null 2>&1
    rm -f ca.key server.csr san.cnf ca.srl
    chmod 644 ca.pem server.pem server.key
  '
}

# A network with no route to the outside, and on it the fixture server,
# answering as the test sites and as TinyFish's and OpenRouter's addresses.
start_fixtures() {
  docker network create --internal "$NET" >/dev/null
  docker run -d --name "$FIX" --network "$NET" \
    --network-alias news.e2e.test --network-alias forum.e2e.test \
    --network-alias control.e2e.test \
    --network-alias api.fetch.tinyfish.ai --network-alias openrouter.ai \
    -v "$HERE/fixtures":/fixtures:ro -v "$WORK/tls":/tls:ro \
    -e E2E_TLS_KEY=/tls/server.key -e E2E_TLS_CERT=/tls/server.pem \
    "$PW_IMAGE" node /fixtures/server.mjs >/dev/null
}

# Follows the app's log into a file and waits for Next to say it is ready.
# Sets LOG_PID. Returns non-zero, after printing the log's tail, if it never is.
wait_for_app() {
  local log="$1"
  docker logs -f "$APP" > "$log" 2>&1 &
  LOG_PID=$!
  for _ in $(seq 1 90); do
    if grep -q "Ready" "$log" 2>/dev/null; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" != "true" ]; then break; fi
    sleep 2
  done
  echo "The app did not start. Its log:" >&2
  tail -40 "$log" >&2
  return 1
}

# Signs the test user in by writing the rows a sign-in leaves (lib/seed.mjs).
seed_session() {
  docker exec -e E2E_SESSION_TOKEN="$1" "$APP" node /e2e/lib/seed.mjs
}
