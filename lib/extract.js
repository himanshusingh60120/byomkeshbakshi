// lib/extract.js
import * as cheerio from 'cheerio';

// Safety valve only. Nothing is truncated for indexing reasons any more.
export const MAX_TEXT_CHARS = 500000;

// Removed in every scope: never renders as reader-visible text.
const ALWAYS_STRIP = 'script,style,noscript,template,svg,iframe';

// Removed in the "content" scope only, so site chrome doesn't drown the article.
const BOILERPLATE = [
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  '.menu',
  '.navbar',
  '.nav',
  '.sidebar',
  '.widget',
  '.breadcrumb',
  '.comments',
  '#comments',
  '.related-posts',
  '.share',
  '.cookie',
  '[aria-hidden="true"]',
].join(',');

const CONTENT_SELECTORS = [
  'article',
  'main',
  '.entry-content',
  '.post-content',
  '.single-content',
  '#content',
  '.content',
];

const BLOCK_TAGS =
  'p,div,li,br,h1,h2,h3,h4,h5,h6,td,tr,section,article,blockquote,figcaption';

/**
 * Collapses runs of ASCII whitespace only.
 *
 * This is the point of the rewrite. \s in JavaScript also matches U+00A0
 * (non-breaking space), U+2009 (thin space), U+202F and friends, so the old
 * `replace(/\s+/g, ' ')` silently destroyed the exact characters we now want
 * to search for. Em dash, en dash, ellipsis, curly quotes and every kind of
 * non-breaking space survive this function untouched.
 */
export function squeezeAsciiWhitespace(text) {
  return text.replace(/[ \t\r\n\f\v]+/g, ' ').trim();
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/**
 * @param {string} html
 * @param {'content'|'page'|'html'} scope
 *   content - article body, site chrome stripped (default)
 *   page    - every visible character in <body>
 *   html    - the raw source, entities and attributes included
 */
export function extractDoc(html, scope = 'content') {
  const $ = cheerio.load(html);

  const title = squeezeAsciiWhitespace(
    firstNonEmpty(
      $('meta[property="og:title"]').attr('content'),
      $('title').first().text(),
      $('h1').first().text()
    )
  ).slice(0, 400);

  if (scope === 'html') {
    return { title, text: html.slice(0, MAX_TEXT_CHARS) };
  }

  $(ALWAYS_STRIP).remove();
  if (scope === 'content') $(BOILERPLATE).remove();

  let root = $('body');
  if (scope === 'content') {
    for (const sel of CONTENT_SELECTORS) {
      const node = $(sel).first();
      if (node.length && node.text().trim().length > 200) {
        root = node;
        break;
      }
    }
  }

  // Keep words from running together across block boundaries.
  root.find(BLOCK_TAGS).after(' ');

  const text = squeezeAsciiWhitespace(root.text()).slice(0, MAX_TEXT_CHARS);
  return { title, text };
}

/** Quick character census, used by /api/preview to sanity-check one page. */
export function charCensus(text) {
  const count = (re) => (text.match(re) || []).length;
  return {
    emDash: count(/\u2014/g),
    enDash: count(/\u2013/g),
    hyphen: count(/-/g),
    ellipsis: count(/\u2026/g),
    nbsp: count(/\u00a0/g),
    curlyDouble: count(/[\u201c\u201d]/g),
    curlySingle: count(/[\u2018\u2019]/g),
  };
}
