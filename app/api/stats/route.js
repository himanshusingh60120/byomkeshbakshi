// app/api/stats/route.js
import { getSql } from '../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sql = getSql();
    const rows = await sql`
      select property,
             count(*)::int as pages,
             count(*) filter (where length(content) > 0)::int as with_text,
             max(indexed_at) as last_indexed
      from pages
      group by property
    `;
    const byProperty = Object.fromEntries(
      rows.map((r) => [
        r.property,
        { pages: r.pages, withText: r.with_text, lastIndexed: r.last_indexed },
      ])
    );
    const totals = rows.reduce(
      (acc, r) => ({ pages: acc.pages + r.pages, withText: acc.withText + r.with_text }),
      { pages: 0, withText: 0 }
    );
    return Response.json({ byProperty, totals });
  } catch (err) {
    console.error('stats failed', err);
    return Response.json({ byProperty: {}, totals: { pages: 0, withText: 0 } });
  }
}
