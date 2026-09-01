// lib/sitemap.js
import { gunzipSync } from 'node:zlib';

export const USER_AGENT =
  'SitemapContentSearchBot/1.0 (+internal content index; contact webmaster)';

function decodeEntities(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/xml,text/xml,*/*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (url.endsWith('.gz')) {
      const buf = Buffer.from(await res.arrayBuffer());
      return gunzipSync(buf).toString('utf8');
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Pulls <url><loc>/<lastmod> pairs out of a sitemap XML string. */
function parseUrlEntries(xml) {
  const entries = [];
  const blockRe = /<url\b[\s\S]*?<\/url>/gi;
  let block;
  while ((block = blockRe.exec(xml))) {
    const chunk = block[0];
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(chunk);
    if (!loc) continue;
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(chunk);
    entries.push({
      url: decodeEntities(loc[1]),
      lastmod: lastmod ? decodeEntities(lastmod[1]) : null,
    });
  }
  // Fallback for sitemaps that don't wrap entries in <url> (rare/malformed)
  if (entries.length === 0) {
    const locRe = /<loc>([\s\S]*?)<\/loc>/gi;
    let m;
    while ((m = locRe.exec(xml))) {
      entries.push({ url: decodeEntities(m[1]), lastmod: null });
    }
  }
  return entries;
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

function parseIndexLocs(xml) {
  const locs = [];
  const re = /<sitemap\b[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi;
  let m;
  while ((m = re.exec(xml))) locs.push(decodeEntities(m[1]));
  return locs;
}

/**
 * Reads one sitemap URL. If it turns out to be a sitemap index,
 * its children are fetched too (one level deep, which covers WP/Yoast).
 */
export async function readSitemap(url, depth = 0) {
  const xml = await fetchText(url);
  if (isSitemapIndex(xml) && depth < 2) {
    const children = parseIndexLocs(xml);
    const out = [];
    for (const child of children) {
      try {
        out.push(...(await readSitemap(child, depth + 1)));
      } catch (err) {
        console.warn(`  ! child sitemap failed ${child}: ${err.message}`);
      }
    }
    return out;
  }
  return parseUrlEntries(xml);
}

/** Collects a deduped list of {url, lastmod} for a property. */
export async function collectPropertyUrls(property, { log = console.log } = {}) {
  const seen = new Map();
  for (const sitemapUrl of property.sitemaps) {
    try {
      const entries = await readSitemap(sitemapUrl);
      let added = 0;
      for (const entry of entries) {
        if (!/^https?:\/\//i.test(entry.url)) continue;
        const key = entry.url.split('#')[0];
        if (!seen.has(key)) {
          seen.set(key, { url: key, lastmod: entry.lastmod });
          added++;
        }
      }
      log(`  ${sitemapUrl} -> ${entries.length} urls (${added} new)`);
    } catch (err) {
      log(`  ! ${sitemapUrl} failed: ${err.message}`);
    }
  }
  return [...seen.values()];
}
