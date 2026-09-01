// app/api/preview/route.js
// Diagnostic. Shows exactly what text one URL yields, so you can confirm a
// site is server-rendered before scanning thousands of its pages.
//
//   /api/preview?url=https://www.kingsresearch.com/some-report&scope=content
import { extractDoc, charCensus } from '../../../lib/extract.js';
import { fetchPage } from '../../../lib/fetcher.js';
import { SCOPES } from '../../../lib/search.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url') || '';
  const scope = SCOPES.includes(searchParams.get('scope')) ? searchParams.get('scope') : 'content';

  if (!/^https?:\/\//i.test(url)) {
    return Response.json({ error: 'Pass a full http(s) URL.' }, { status: 400 });
  }

  const page = await fetchPage(url, { noCache: true });
  if (!page.ok) {
    return Response.json({ url, ok: false, reason: page.reason }, { status: 502 });
  }

  const doc = extractDoc(page.html, scope);
  return Response.json({
    url,
    ok: true,
    scope,
    htmlBytes: page.html.length,
    title: doc.title,
    textChars: doc.text.length,
    census: charCensus(doc.text),
    sample: doc.text.slice(0, 600),
  });
}
