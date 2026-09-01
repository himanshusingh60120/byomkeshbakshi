// lib/fetcher.js
import { USER_AGENT } from './sitemap.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_BYTES = 200 * 1024; // don't cache monster pages

// Survives between requests on a warm serverless instance, which makes
// re-running a second search over the same batch close to instant.
const cache = new Map();

function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  // refresh recency
  cache.delete(url);
  cache.set(url, hit);
  return hit.html;
}

function cacheSet(url, html) {
  if (html.length > CACHE_MAX_BYTES) return;
  cache.set(url, { at: Date.now(), html });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

export function clearPageCache() {
  cache.clear();
}

export async function fetchPage(url, { timeoutMs = 20000, retries = 1, noCache = false } = {}) {
  if (!noCache) {
    const cached = cacheGet(url);
    if (cached !== null) return { ok: true, status: 200, html: cached, cached: true };
  }

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
        return { ok: false, status: res.status, reason: `not html (${type.split(';')[0]})` };
      }
      const html = await res.text();
      if (!noCache) cacheSet(url, html);
      return { ok: true, status: res.status, html, cached: false };
    } catch (err) {
      if (attempt < retries) continue;
      return {
        ok: false,
        status: 0,
        reason: err.name === 'AbortError' ? 'timeout' : err.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, reason: 'unknown' };
}

/** Runs `worker` over `items` with a fixed number of parallel lanes. */
export async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index], index);
      }
    }
  );
  await Promise.all(lanes);
}
