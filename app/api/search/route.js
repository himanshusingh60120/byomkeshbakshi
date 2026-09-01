// app/api/search/route.js
import { getSql } from '../../../lib/db.js';
import { PROPERTY_IDS } from '../../../lib/properties.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Upper bound on rows examined, so one very common phrase can't stall the page.
const CANDIDATE_LIMIT = 5000;
const SCAN_LIMIT = 2000;

const HL_START = '@@S@@';
const HL_END = '@@E@@';
const HL_DELIM = '@@D@@';
const HEADLINE_OPTS = `StartSel=${HL_START}, StopSel=${HL_END}, FragmentDelimiter=${HL_DELIM}, MaxFragments=3, MaxWords=34, MinWords=16`;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ELLIPSIS = '<span class="ellipsis">…</span>';

function fromHeadline(raw) {
  if (!raw) return '';
  const fragments = escapeHtml(raw)
    .split(HL_DELIM)
    .map((part) => part.trim())
    .filter(Boolean);
  if (fragments.length === 0) return '';

  let html = fragments
    .join(` ${ELLIPSIS} `)
    .replaceAll(HL_START, '<mark>')
    .replaceAll(HL_END, '</mark>')
    // A phrase comes back word by word; join the run into one highlight.
    .replace(/<\/mark>(\s+)<mark>/g, '$1');

  const first = fragments[0].replace(HL_START, '').trimStart();
  const last = fragments[fragments.length - 1].replace(HL_END, '').trimEnd();
  if (first && first[0] === first[0].toLowerCase() && /[a-z]/i.test(first[0])) {
    html = `${ELLIPSIS} ${html}`;
  }
  if (last && !/[.!?:;"')\]]$/.test(last)) {
    html = `${html} ${ELLIPSIS}`;
  }
  return html;
}

function fromSubstring(raw, term) {
  if (!raw) return '';
  const escaped = escapeHtml(raw);
  if (!term) return escaped;
  const re = new RegExp(escapeRegExp(escapeHtml(term)), 'gi');
  return escaped.replace(re, (m) => `<mark>${m}</mark>`);
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim();
  const requested = searchParams.get('property') || 'all';
  const property =
    requested === 'all' || PROPERTY_IDS.includes(requested) ? requested : 'all';
  const mode = searchParams.get('mode') === 'words' ? 'words' : 'exact';
  const page = Math.max(1, Number(searchParams.get('page') || 1));
  const perPage = Math.min(200, Math.max(1, Number(searchParams.get('perPage') || 20)));
  const offset = (page - 1) * perPage;

  if (q.length < 2) {
    return Response.json({ error: 'Type at least 2 characters to search.' }, { status: 400 });
  }

  const startedAt = Date.now();

  try {
    const sql = getSql();
    // Punctuation-only or stopword-only input produces an empty tsquery and
    // has to fall back to a scan.
    const tsqRows =
      mode === 'exact'
        ? await sql`select phraseto_tsquery('english', ${q})::text as tsq`
        : await sql`select websearch_to_tsquery('english', ${q})::text as tsq`;
    const indexed = Boolean(tsqRows[0]?.tsq);

    let rows;
    let capped = false;

    if (indexed && mode === 'exact') {
      // Rank on the index first, then confirm the literal string is really
      // present (tsquery ignores punctuation, casing and word endings).
      rows = await sql`
        with q as (select phraseto_tsquery('english', ${q}) as tsq),
        candidates as (
          select p.id, p.url, p.title, p.property, p.lastmod,
                 ts_rank(p.tsv, (select tsq from q)) as rank,
                 (count(*) over ())::int as candidate_total
          from pages p
          where (${property} = 'all' or p.property = ${property})
            and p.tsv @@ (select tsq from q)
          order by rank desc, p.lastmod desc nulls last
          limit ${CANDIDATE_LIMIT}
        ),
        verified as (
          select c.id, c.url, c.title, c.property, c.lastmod, c.rank, c.candidate_total,
                 (char_length(coalesce(p.title,'') || ' ' || p.content)
                   - char_length(replace(lower(coalesce(p.title,'') || ' ' || p.content), lower(${q}), '')))
                   / greatest(char_length(${q}), 1) as hits,
                 (count(*) over ())::int as total
          from candidates c
          join pages p on p.id = c.id
          where position(lower(${q}) in lower(coalesce(p.title,'') || ' ' || p.content)) > 0
          order by c.rank desc, c.lastmod desc nulls last
          limit ${perPage} offset ${offset}
        )
        select v.*, ts_headline(
                 'english',
                 coalesce(p.title,'') || ' — ' || p.content,
                 (select tsq from q),
                 ${HEADLINE_OPTS}
               ) as snippet
        from verified v
        join pages p on p.id = v.id
        order by v.rank desc, v.lastmod desc nulls last
      `;
      capped = (rows[0]?.candidate_total ?? 0) >= CANDIDATE_LIMIT;
    } else if (indexed) {
      rows = await sql`
        with q as (select websearch_to_tsquery('english', ${q}) as tsq),
        matched as (
          select p.id, p.url, p.title, p.property, p.lastmod,
                 ts_rank(p.tsv, (select tsq from q)) as rank,
                 null::int as hits,
                 (count(*) over ())::int as total
          from pages p
          where (${property} = 'all' or p.property = ${property})
            and p.tsv @@ (select tsq from q)
          order by rank desc, p.lastmod desc nulls last
          limit ${perPage} offset ${offset}
        )
        select m.*, ts_headline(
                 'english',
                 coalesce(p.title,'') || ' — ' || p.content,
                 (select tsq from q),
                 ${HEADLINE_OPTS}
               ) as snippet
        from matched m
        join pages p on p.id = m.id
        order by m.rank desc, m.lastmod desc nulls last
      `;
    } else {
      // No usable tsquery, e.g. "?utm_source=" or "&nbsp;". Straight substring
      // scan, stopped early at SCAN_LIMIT.
      rows = await sql`
        with candidates as (
          select p.id, p.url, p.title, p.property, p.lastmod,
                 position(lower(${q}) in lower(coalesce(p.title,'') || ' ' || p.content)) as pos
          from pages p
          where (${property} = 'all' or p.property = ${property})
            and position(lower(${q}) in lower(coalesce(p.title,'') || ' ' || p.content)) > 0
          limit ${SCAN_LIMIT}
        ),
        paged as (
          select c.*, 0::float4 as rank, null::int as hits,
                 (count(*) over ())::int as total
          from candidates c
          order by c.lastmod desc nulls last
          limit ${perPage} offset ${offset}
        )
        select pg.*, substring(coalesce(p.title,'') || ' — ' || p.content
                               from greatest(1, pg.pos - 130) for 340) as snippet
        from paged pg
        join pages p on p.id = pg.id
        order by pg.lastmod desc nulls last
      `;
      capped = (rows[0]?.total ?? 0) >= SCAN_LIMIT;
    }

    const total = rows[0]?.total ?? 0;
    const results = rows.map((r) => ({
      url: r.url,
      title: r.title || r.url,
      property: r.property,
      lastmod: r.lastmod,
      hits: r.hits ?? null,
      snippetHtml: indexed ? fromHeadline(r.snippet) : fromSubstring(r.snippet, q),
    }));

    return Response.json({
      query: q,
      property,
      mode,
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      tookMs: Date.now() - startedAt,
      scanned: !indexed,
      capped,
      results,
    });
  } catch (err) {
    console.error('search failed', err);
    return Response.json(
      { error: 'Search failed. Check the database connection and try again.' },
      { status: 500 }
    );
  }
}
