#!/bin/bash
set -e

echo "=== rightread startup ==="

# Bring the SQLite schema up to date before serving.
echo "Syncing database schema..."
npx prisma db push --skip-generate

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
