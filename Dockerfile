# Node 24, not 20: scripts/db-backup.mjs and scripts/db-merge.mjs use the
# built-in `node:sqlite`, which does not exist before Node 22. On Node 20 the
# app runs fine but both database tools die with ERR_UNKNOWN_BUILTIN_MODULE —
# i.e. no backups and no way to seed the server without losing data.
FROM node:24-bookworm-slim

WORKDIR /app

# Install dependencies first so this layer caches across source changes.
COPY package*.json ./
RUN npm ci

COPY . .

# SQLite lives on a mounted volume so the library survives redeploys.
RUN mkdir -p /app/data
ENV DATABASE_URL="file:/app/data/production.db"

RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Fix Windows CRLF so the script is executable on Linux.
COPY start.sh /app/start.sh
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

CMD ["/app/start.sh"]
