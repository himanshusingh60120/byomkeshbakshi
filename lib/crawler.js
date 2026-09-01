// lib/crawler.js
import { extractContent } from './extract.js';
import { USER_AGENT } from './sitemap.js';

export async function fetchPage(url, { timeoutMs = 25000, retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      const type = res.headers.get('content-type') || '';
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) continue;
        return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
      }
      if (!type.includes('html')) {
        return { ok: false, status: res.status, reason: `type ${type}` };
      }
      const html = await res.text();
      return { ok: true, status: res.status, html };
    } catch (err) {
      if (attempt < retries) continue;
      return { ok: false, status: 0, reason: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, reason: 'unknown' };
}

/**
 * Runs `worker` over `items` with a fixed number of parallel lanes.
 */
export async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}

export function toRecord(property, entry, page) {
  if (!page.ok) {
    return {
      property,
      url: entry.url,
      title: null,
      description: null,
      content: '',
      lastmod: entry.lastmod,
      status: page.status || 0,
      ok: false,
      reason: page.reason,
    };
  }
  const { title, description, content } = extractContent(page.html);
  return {
    property,
    url: entry.url,
    title,
    description,
    content,
    lastmod: entry.lastmod,
    status: page.status,
    ok: true,
  };
}

/** Builds one multi-row upsert for a batch of records. */
export function buildUpsert(records) {
  const cols = {
    property: [],
    url: [],
    title: [],
    description: [],
    content: [],
    lastmod: [],
    status: [],
  };
  for (const r of records) {
    cols.property.push(r.property);
    cols.url.push(r.url);
    cols.title.push(r.title ?? null);
    cols.description.push(r.description ?? null);
    cols.content.push(r.content ?? '');
    cols.lastmod.push(normalizeDate(r.lastmod));
    cols.status.push(r.status ?? 0);
  }
  const text = `
    insert into pages (property, url, title, description, content, lastmod, status, indexed_at)
    select p, u, t, d, c, lm, st, now()
    from unnest(
      $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::int[]
    ) as x(p, u, t, d, c, lm, st)
    on conflict (url) do update set
      property    = excluded.property,
      title       = excluded.title,
      description = excluded.description,
      content     = excluded.content,
      lastmod     = excluded.lastmod,
      status      = excluded.status,
      indexed_at  = now()
  `;
  return {
    text,
    params: [
      cols.property,
      cols.url,
      cols.title,
      cols.description,
      cols.content,
      cols.lastmod,
      cols.status,
    ],
  };
}

function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
