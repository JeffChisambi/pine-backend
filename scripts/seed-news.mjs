#!/usr/bin/env node
/**
 * Seed the news_articles table with launch content from scripts/news-seed.json.
 * Idempotent: skips any article whose title already exists.
 *
 *   docker exec kapwanje-api node scripts/seed-news.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const articles = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'news-seed.json'), 'utf8'),
);

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseTime(t) {
  const m = String(t).match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!m) return new Date();
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[2]] ?? 0, Number(m[1])));
}

let created = 0;
let skipped = 0;
for (const a of articles) {
  const exists = await prisma.newsArticle.findFirst({ where: { title: a.title } });
  if (exists) {
    skipped++;
    continue;
  }
  await prisma.newsArticle.create({
    data: {
      category: a.category,
      title: a.title,
      summary: a.summary ?? null,
      body: a.body,
      source: a.source,
      imageUrl: a.imageUrl ?? null,
      featured: !!a.featured,
      isPublished: true,
      publishedAt: parseTime(a.time),
    },
  });
  created++;
}

console.log(`News seed complete: ${created} created, ${skipped} skipped.`);
await prisma.$disconnect();
