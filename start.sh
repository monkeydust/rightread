#!/bin/bash
set -e

echo "=== rightread startup ==="

# Bring the SQLite schema up to date before serving.
echo "Syncing database schema..."
npx prisma db push --skip-generate

echo "Starting Next.js..."
exec npm start
