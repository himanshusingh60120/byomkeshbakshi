// scripts/crawl.mjs
import 'dotenv/config';
import pg from 'pg';
import { PROPERTIES, getProperty } from '../lib/properties.js';
import { collectPropertyUrls } from '../lib/sitemap.js';
import { fetchPage, runPool, toRecord, buildUpsert } from '../lib/crawler.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const CONCURRENCY = Number(args.concurrency || 8);
const BATCH_SIZE = Number(args.batch || 25);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const FORCE = Boolean(args.force);
const PRUNE = Boolean(args.prune);
const STALE_DAYS = Number(args['stale-days'] || 30);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env first.');
  process.exit(1);
}

const targets = args.property
  ? String(args.property)
      .split(',')
      .map((id) => {
        const p = getProperty(id.trim());
        if (!p) {
          console.error(`Unknown property "${id}". Known ids: ${PROPERTIES.map((x) => x.id).join(', ')}`);
          process.exit(1);
        }
        return p;
      })
  : PROPERTIES;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

function sameDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return Math.abs(da.getTime() - db.getTime()) < 1000;
}

async function flush(records) {
  if (records.length === 0) return;
  const { text, params } = buildUpsert(records);
  await pool.query(text, params);
}

const started = Date.now();
let grandTotal = 0;

for (const property of targets) {
  console.log(`\n=== ${property.name} (${property.id}) ===`);
  console.log('Reading sitemaps...');
  const entries = await collectPropertyUrls(property);
  console.log(`Found ${entries.length} unique URLs.`);

  const { rows: existingRows } = await pool.query(
    'select url, lastmod, indexed_at, length(content) as len from pages where property = $1',
    [property.id]
  );
  const existing = new Map(existingRows.map((r) => [r.url, r]));

  const staleCutoff = Date.now() - STALE_DAYS * 86400000;
  const queue = entries.filter((entry) => {
    if (FORCE) return true;
    const row = existing.get(entry.url);
    if (!row) return true;
    if (!row.len) return true; // previously failed or empty
    if (entry.lastmod && !sameDay(entry.lastmod, row.lastmod)) return true;
    if (!entry.lastmod && new Date(row.indexed_at).getTime() < staleCutoff) return true;
    return false;
  });

  const work = queue.slice(0, LIMIT === Infinity ? queue.length : LIMIT);
  console.log(
    `${existing.size} already indexed. ${work.length} to fetch${
      work.length < queue.length ? ` (limited from ${queue.length})` : ''
    }.`
  );

  let done = 0;
  let failed = 0;
  let buffer = [];

  await runPool(work, CONCURRENCY, async (entry) => {
    const page = await fetchPage(entry.url);
    const record = toRecord(property.id, entry, page);
    if (!record.ok) {
      failed++;
      if (failed <= 15) console.warn(`  ! ${entry.url} — ${record.reason}`);
    }
    buffer.push(record);
    done++;

    if (buffer.length >= BATCH_SIZE) {
      const batch = buffer;
      buffer = [];
      await flush(batch);
    }
    if (done % 100 === 0 || done === work.length) {
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(
        `  ${done}/${work.length} pages · ${failed} failed · ${rate.toFixed(1)}/s\n`
      );
    }
  });

  await flush(buffer);
  grandTotal += done;

  if (PRUNE) {
    const urls = entries.map((e) => e.url);
    const { rowCount } = await pool.query(
      'delete from pages where property = $1 and not (url = any($2::text[]))',
      [property.id, urls]
    );
    console.log(`Pruned ${rowCount} URLs no longer in the sitemaps.`);
  }

  const { rows: countRows } = await pool.query(
    'select count(*)::int as n from pages where property = $1 and length(content) > 0',
    [property.id]
  );
  console.log(`${property.name}: ${countRows[0].n} pages with indexed text.`);
}

await pool.end();
console.log(
  `\nDone. Processed ${grandTotal} pages in ${((Date.now() - started) / 60000).toFixed(1)} min.`
);
