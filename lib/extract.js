// lib/extract.js
import * as cheerio from 'cheerio';

// Postgres tsvector caps at ~1MB; 80k chars keeps rows small and searches fast.
export const MAX_CONTENT_CHARS = 80000;

const STRIP = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'form',
  'nav',
  'header',
  'footer',
  'aside',
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

function normalize(text) {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractContent(html) {
  const $ = cheerio.load(html);

  const title = normalize(
    $('meta[property="og:title"]').attr('content') ||
      $('title').first().text() ||
      $('h1').first().text() ||
      ''
  ).slice(0, 500);

  const description = normalize(
    $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      ''
  ).slice(0, 1000);

  $(STRIP).remove();

  let root = null;
  for (const sel of CONTENT_SELECTORS) {
    const node = $(sel).first();
    if (node.length && normalize(node.text()).length > 200) {
      root = node;
      break;
    }
  }
  if (!root) root = $('body');

  // Insert spaces at block boundaries so words don't run together.
  root.find('p, div, li, br, h1, h2, h3, h4, h5, h6, td, tr, section').after(' ');

  let content = normalize(root.text());
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS);
  }

  return { title, description, content };
}
