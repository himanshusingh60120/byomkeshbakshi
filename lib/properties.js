// lib/properties.js
// Central config. Add or remove properties here and re-run the crawler.

function postSitemaps(domain, count, { includePage = false } = {}) {
  const list = [`https://${domain}/post-sitemap.xml`];
  for (let i = 2; i <= count; i++) {
    list.push(`https://${domain}/post-sitemap${i}.xml`);
  }
  if (includePage) list.push(`https://${domain}/page-sitemap.xml`);
  return list;
}

export const PROPERTIES = [
  {
    id: 'kingsresearch',
    name: 'Kings Research',
    domain: 'kingsresearch.com',
    sitemaps: [
      'https://www.kingsresearch.com/sitemap-reports.xml',
      'https://www.kingsresearch.com/sitemap-blogs.xml',
      'https://www.kingsresearch.com/sitemap-pr.xml',
    ],
  },
  {
    id: 'martech360',
    name: 'MarTech360',
    domain: 'martech360.com',
    sitemaps: ['https://martech360.com/sitemap-posts.xml'],
  },
  {
    id: 'itbusinesstoday',
    name: 'IT Business Today',
    domain: 'itbusinesstoday.com',
    sitemaps: postSitemaps('itbusinesstoday.com', 7, { includePage: true }),
  },
  {
    id: 'itdigest',
    name: 'IT Digest',
    domain: 'itdigest.com',
    sitemaps: postSitemaps('itdigest.com', 21),
  },
  {
    id: 'aitech365',
    name: 'AITech365',
    domain: 'aitech365.com',
    sitemaps: postSitemaps('aitech365.com', 11, { includePage: true }),
  },
  {
    id: 'readmagazine',
    name: 'Read Magazine',
    domain: 'readmagazine.com',
    sitemaps: postSitemaps('readmagazine.com', 23),
  },
];

export const PROPERTY_IDS = PROPERTIES.map((p) => p.id);

export function getProperty(id) {
  return PROPERTIES.find((p) => p.id === id) || null;
}
