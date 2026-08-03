#!/usr/bin/env node
/**
 * Builds the search index for items that predate it.
 *
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/search-backfill.mjs [--force] [--limit N] [--index-only]
 *
 * Rebuilds the FTS index (cheap, local) and embeds anything without a vector
 * (a network call each, so it reports cost as it goes). Idempotent: rerunning
 * only embeds what is still missing, unless --force.
 *
 * --index-only skips embedding entirely. That is what start.sh runs at boot:
 * the index has just been dropped for `prisma db push`, and recreating it
 * there means the triggers exist before the app serves its first request,
 * rather than only after someone happens to search. Boot must not depend on
 * the network, hence the flag.
 */

import "dotenv/config";
import { argv } from "node:process";
import { prisma } from "../src/lib/db.ts";
import { reindexAll } from "../src/lib/search/index-schema.ts";
import { embed, embeddableText, toBlob, EMBED_MODEL } from "../src/lib/search/embed.ts";

const force = argv.includes("--force");
const indexOnly = argv.includes("--index-only");
const limit = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : undefined;

console.log("\nRebuilding the full-text index…");
const indexed = await reindexAll();
console.log(`  ${indexed} rows indexed\n`);

if (indexOnly) {
  await prisma.$disconnect();
  process.exit(0);
}

const items = await prisma.item.findMany({
  where: force ? {} : { embedding: null },
  select: {
    id: true,
    title: true,
    siteName: true,
    excerpt: true,
    textContent: true,
  },
  take: limit,
});

if (items.length === 0) {
  console.log("Every item already has an embedding — nothing to do.\n");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Embedding ${items.length} item(s) with ${EMBED_MODEL}…`);
let done = 0;
let failed = 0;

for (const item of items) {
  const text = embeddableText(item);
  if (!text.trim()) {
    console.log(`  skip  ${item.title.slice(0, 52)} (no text)`);
    continue;
  }
  try {
    const vector = await embed(text);
    await prisma.item.update({
      where: { id: item.id },
      data: {
        embedding: toBlob(vector),
        embeddingModel: EMBED_MODEL,
        embeddedAt: new Date(),
      },
    });
    done++;
    console.log(`  ok    ${item.title.slice(0, 52)}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${item.title.slice(0, 52)} — ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`\n${done} embedded, ${failed} failed.\n`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
