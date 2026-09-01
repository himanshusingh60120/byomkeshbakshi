// app/api/scan/route.js
// Fetches one batch of URLs live and searches their text. Stateless: the
// client owns the URL list and decides how the batches are paced.
import { extractDoc } from '../../../lib/extract.js';
import { fetchPage, runPool } from '../../../lib/fetcher.js';
import { buildMatcher, findMatches, buildSnippets, plainSnippet, MODES, SCOPES } from '../../../lib/search.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const MAX_BATCH = 60;

export async function POST(request) {
  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const q = typeof body.q === 'string' ? body.q : '';
  const mode = MODES.includes(body.mode) ? body.mode : 'exact';
  const scope = SCOPES.includes(body.scope) ? body.scope : 'content';
  const matchCase = Boolean(body.matchCase);
  const concurrency = Math.min(12, Math.max(1, Number(body.concurrency) || 8));
  const noCache = Boolean(body.noCache);
  const urls = Array.isArray(body.urls) ? body.urls.filter((u) => typeof u === 'string') : [];

  // One character is a legitimate search here — that is the em dash case.
  if (!q) {
    return Response.json({ error: 'Type something to search for.' }, { status: 400 });
  }
  if (urls.length === 0) {
    return Response.json({ error: 'No URLs in this batch.' }, { status: 400 });
  }
  if (urls.length > MAX_BATCH) {
    return Response.json(
      { error: `Batch too large. Send at most ${MAX_BATCH} URLs.` },
      { status: 400 }
    );
  }

  let matcher;
  try {
    matcher = buildMatcher(q, { mode, matchCase });
  } catch (err) {
    return Response.json({ error: `Bad query: ${err.message}` }, { status: 400 });
  }

  const results = [];
  const errors = [];
  let emptyText = 0;
  let fromCache = 0;

  await runPool(urls, concurrency, async (url) => {
    const page = await fetchPage(url, { noCache });
    if (!page.ok) {
      errors.push({ url, reason: page.reason });
      return;
    }
    if (page.cached) fromCache++;

    let doc;
    try {
      doc = extractDoc(page.html, scope);
    } catch (err) {
      errors.push({ url, reason: `parse failed: ${err.message}` });
      return;
    }

    if (!doc.text) {
      emptyText++;
      return;
    }

    // The title is searched too, joined by a newline so a match can never
    // straddle the boundary and report a phrase that isn't really there.
    const haystack = scope === 'html' ? doc.text : `${doc.title}\n${doc.text}`;
    const found = findMatches(haystack, matcher);
    if (!found) return;

    results.push({
      url,
      title: doc.title || url,
      hits: found.hits,
      snippets: buildSnippets(haystack, found.spans),
      plain: plainSnippet(haystack, found.spans),
      chars: doc.text.length,
    });
  });

  return Response.json({
    scanned: urls.length,
    matched: results.length,
    failed: errors.length,
    emptyText,
    fromCache,
    tookMs: Date.now() - startedAt,
    results,
    errors: errors.slice(0, 10),
  });
}
