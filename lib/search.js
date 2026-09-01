// lib/search.js
// Literal, character-exact matching. No stemming, no stopwords, no tokenizer
// deciding that "—" isn't a word. What you type is what gets looked for.

export const MODES = ['exact', 'words', 'regex'];
export const SCOPES = ['content', 'page', 'html'];

const MAX_MATCHES_PER_PAGE = 2000;
const SNIPPET_BEFORE = 110;
const SNIPPET_AFTER = 150;
const MAX_SNIPPETS = 3;

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} q
 * @param {{mode?: 'exact'|'words'|'regex', matchCase?: boolean}} opts
 * @returns {{terms: RegExp[], requireAll: boolean}}
 * @throws if the query is empty or an invalid regex
 */
export function buildMatcher(q, { mode = 'exact', matchCase = false } = {}) {
  const flags = matchCase ? 'gu' : 'giu';

  if (mode === 'regex') {
    if (!q) throw new Error('Empty pattern.');
    if (q.length > 400) throw new Error('Pattern is too long.');
    let re;
    try {
      re = new RegExp(q, flags);
    } catch {
      // Some patterns are only valid without the unicode flag.
      re = new RegExp(q, matchCase ? 'g' : 'gi');
    }
    return { terms: [re], requireAll: false };
  }

  if (mode === 'words') {
    const tokens = [...new Set(q.split(/\s+/).filter(Boolean))];
    if (tokens.length === 0) throw new Error('Empty query.');
    return {
      terms: tokens.map((t) => new RegExp(escapeRegExp(t), flags)),
      requireAll: true,
    };
  }

  if (!q) throw new Error('Empty query.');
  return { terms: [new RegExp(escapeRegExp(q), flags)], requireAll: false };
}

function collect(text, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // zero-width match, don't spin forever
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
    if (out.length >= MAX_MATCHES_PER_PAGE) break;
  }
  return out;
}

/**
 * @returns {{hits: number, spans: [number, number][]} | null} null when the
 * page does not match at all.
 */
export function findMatches(text, matcher) {
  if (!text) return null;
  const all = [];
  for (const re of matcher.terms) {
    const spans = collect(text, re);
    if (matcher.requireAll && spans.length === 0) return null;
    all.push(...spans);
  }
  if (all.length === 0) return null;
  all.sort((a, b) => a[0] - b[0]);
  return { hits: all.length, spans: all };
}

const ELLIPSIS = '<span class="ellipsis">\u2026</span>';

/** True when the matched run is made only of space-like characters. */
function isWhitespaceOnly(chunk) {
  return /^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/.test(
    chunk
  );
}

function renderWindow(text, from, to, spans) {
  let html = '';
  let cursor = from;
  for (const [start, end] of spans) {
    if (start >= to) break;
    if (end <= from) continue;
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    if (s > cursor) html += escapeHtml(text.slice(cursor, s));
    const chunk = text.slice(s, e);
    const cls = isWhitespaceOnly(chunk) ? ' class="ws"' : '';
    html += `<mark${cls}>${escapeHtml(chunk)}</mark>`;
    cursor = e;
  }
  if (cursor < to) html += escapeHtml(text.slice(cursor, to));
  // The only newline in extracted text is the title/body join, so show it as
  // a divider rather than letting HTML collapse it into a space.
  html = html.replace(/\n/g, '<span class="sep">\u00b7</span>');
  if (from > 0) html = `${ELLIPSIS} ${html}`;
  if (to < text.length) html = `${html} ${ELLIPSIS}`;
  return html;
}

/** Up to MAX_SNIPPETS non-overlapping windows of context around the hits. */
export function buildSnippets(text, spans) {
  const snippets = [];
  let lastEnd = -1;
  for (const span of spans) {
    if (snippets.length >= MAX_SNIPPETS) break;
    if (span[0] < lastEnd) continue; // already inside a rendered window
    const from = Math.max(0, span[0] - SNIPPET_BEFORE);
    const to = Math.min(text.length, span[1] + SNIPPET_AFTER);
    snippets.push(renderWindow(text, from, to, spans));
    lastEnd = to;
  }
  return snippets;
}

/** Plain-text version of the first snippet, for CSV export. */
export function plainSnippet(text, spans) {
  if (!spans.length) return '';
  const [start, end] = spans[0];
  const from = Math.max(0, start - SNIPPET_BEFORE);
  const to = Math.min(text.length, end + SNIPPET_AFTER);
  return text.slice(from, to);
}
