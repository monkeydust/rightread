#!/bin/bash
set -e

echo "=== rightread startup ==="

# The FTS5 index and its triggers cannot be expressed in schema.prisma, so
# `db push` sees unowned objects, calls dropping them data loss and refuses to
# run — killing the container under `set -e`. Drop them first; the index is
# derived from Item and rebuilds itself on the next search. See the long note
# in the script for why this is done here rather than with --accept-data-loss.
echo "Dropping derived search index before schema sync..."
node scripts/drop-search-objects.mjs

# Bring the SQLite schema up to date before serving.
echo "Syncing database schema..."
npx prisma db push --skip-generate

# Recreate the index and its triggers straight away, rather than leaving it to
# whenever someone first searches. Without this there is a window after every
# restart in which the triggers do not exist; nothing is lost (the rebuild
# reads from Item) but a save in that window is invisible to search until the
# next rebuild. `|| true` because a warm cache is not worth failing a boot for
# — ensureSearchIndex() still rebuilds on demand if this does not run.
echo "Rebuilding search index..."
npm run search:backfill -- --index-only || echo "  index rebuild skipped; it will rebuild on first search"

# A missing key degrades classification silently to "other" — which is correct
# behaviour but invisible, so say so once, loudly, where `docker logs` shows it.
if [ -z "$OPENROUTER_API_KEY" ]; then
  echo "WARNING: OPENROUTER_API_KEY is not set in the container."
  echo "         Page classification will degrade to \"other\" for every save."
  echo "         Check it is listed under 'environment:' in docker-compose.yml —"
  echo "         being present in .env.prod alone is NOT enough."
else
  echo "OpenRouter configured (model: ${OPENROUTER_MODEL:-default})"
fi

echo "Starting Next.js..."
exec npm start
