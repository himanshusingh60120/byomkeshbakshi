// app/api/urls/route.js
// Returns the live URL list for a property, straight from its sitemaps.
import { PROPERTIES, getProperty } from '../../../lib/properties.js';
import { getPropertyUrls } from '../../../lib/sitemap.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('property') || 'kingsresearch';
  const refresh = searchParams.get('refresh') === '1';

  const targets = id === 'all' ? PROPERTIES : [getProperty(id)].filter(Boolean);
  if (targets.length === 0) {
    return Response.json({ error: `Unknown property "${id}".` }, { status: 400 });
  }

  try {
    const seen = new Set();
    const urls = [];
    let cachedAt = 0;

    for (const property of targets) {
      const res = await getPropertyUrls(property, { refresh });
      cachedAt = Math.max(cachedAt, res.cachedAt);
      for (const entry of res.urls) {
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        urls.push({ url: entry.url, lastmod: entry.lastmod, property: property.id });
      }
    }

    return Response.json({
      property: id,
      count: urls.length,
      cachedAt: new Date(cachedAt).toISOString(),
      urls,
    });
  } catch (err) {
    console.error('urls failed', err);
    return Response.json(
      { error: `Could not read the sitemaps: ${err.message}` },
      { status: 502 }
    );
  }
}
