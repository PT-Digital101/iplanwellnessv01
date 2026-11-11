// XML sitemaps: /sitemap_index.xml (the address Search Console and robots.txt use) and one child sitemap per kind
// of page (xmlSitemaps in migration.config.json; keep the old site's file names). Every built page whose canonical
// is itself and that is not noindex goes in, with its hreflang twins (xhtml:link), its images and, on the pages
// named in videoSitemapPaths, the YouTube video of its VideoObject. Playbook 05.
import fs from 'node:fs';
import path from 'node:path';
import { escapeXml, stripLocale } from './util.mjs';

/** Which child sitemap a page belongs in: the first whose `paths` (regular expressions) match the page's path
 *  without its locale prefix, else the first whose `types` include one of the page's JSON-LD types, else the
 *  first that has neither. */
export function sitemapFor(page, sitemaps, locales) {
  const p = stripLocale(page.path, locales);
  for (const s of sitemaps) if (s.paths?.some((re) => new RegExp(re).test(p))) return s.file;
  for (const s of sitemaps) if (s.types?.some((t) => page.types.has(t))) return s.file;
  return (sitemaps.find((s) => !s.paths && !s.types) ?? sitemaps[0]).file;
}

/** Pages that belong in a sitemap: canonical to itself, not noindex. */
export function indexable(page) {
  return page.selfCanonical && !page.noindex;
}

/**
 * @param {object} o
 * @param {import('./pages.mjs').Page[]} o.pages
 * @param {string} o.distDir
 * @param {string} o.site e.g. https://www.example.com
 * @param {(path: string) => {date?: string, from: string}} o.lastmod
 * @param {{default: string, prefixed: string[]}} o.locales
 * @param {object} o.settings migration.config.json
 */
export function buildXmlSitemaps({ pages, distDir, site, lastmod, locales, settings }) {
  const SITEMAPS = settings.xmlSitemaps;
  const videoPaths = (settings.videoSitemapPaths ?? []).map((re) => new RegExp(re));
  const videoPage = (page) => videoPaths.some((re) => re.test(stripLocale(page.path, locales)));
  // Images: each source image once per page (Astro writes several sizes and formats of it), and only the page's
  // own images. Images on more than SHARED pages (cards of other pages, CTA backgrounds) are left out, except a
  // page's share image (og:image), which is listed first.
  const SHARED = 4;
  const base = (url) => url.replace(/^(.*\/_astro\/[^/]+?\.[\w-]{8})[_.].*$/, '$1');
  const usage = new Map();
  for (const p of pages) for (const b of new Set(p.images.map(base))) usage.set(b, (usage.get(b) ?? 0) + 1);
  const ownImages = (page) => {
    const seen = new Set();
    return page.images.filter((img) => {
      const b = base(img);
      if (seen.has(b) || (img !== page.ogImage && usage.get(b) > SHARED)) return false;
      seen.add(b);
      return true;
    });
  };

  const built = new Set(pages.map((p) => p.path));
  const buckets = new Map(SITEMAPS.map((s) => [s.file, []]));
  const excluded = [];
  const lastmodFrom = {};
  for (const page of pages) {
    if (!indexable(page)) {
      excluded.push({ path: page.path, reason: page.noindex ? 'noindex' : `canonical is ${page.canonical || 'missing'}` });
      continue;
    }
    const lm = lastmod(page.path);
    lastmodFrom[lm.from] = (lastmodFrom[lm.from] ?? 0) + 1;
    buckets.get(sitemapFor(page, SITEMAPS, locales)).push(urlEntry(page, lm.date, ownImages(page), built, videoPage(page)));
  }

  const counts = {};
  const indexEntries = [];
  for (const { file } of SITEMAPS) {
    const entries = buckets.get(file);
    counts[file] = entries.length;
    if (!entries.length) continue;
    const newest = entries.map((e) => e.lastmod).filter(Boolean).sort().at(-1);
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
      ...entries.map((e) => e.xml),
      '</urlset>',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(distDir, file), xml);
    indexEntries.push(`<sitemap><loc>${escapeXml(`${site}/${file}`)}</loc>${newest ? `<lastmod>${newest}</lastmod>` : ''}</sitemap>`);
  }
  fs.writeFileSync(
    path.join(distDir, 'sitemap_index.xml'),
    ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...indexEntries, '</sitemapindex>', ''].join('\n'),
  );
  return { counts, excluded, lastmodFrom, files: ['sitemap_index.xml', ...SITEMAPS.map((s) => s.file).filter((f) => counts[f])] };
}

function urlEntry(page, lastmod, images, built, withVideo) {
  const parts = [`<loc>${escapeXml(page.canonical)}</loc>`];
  if (lastmod) parts.push(`<lastmod>${lastmod}</lastmod>`);
  // Twins in other languages: only when the page has a built one (a single-language page lists just itself).
  // A twin that isn't built yet is left out here; check:dist reports the page's hreflang tag.
  const alternates = page.alternates.filter((a) => !a.path || built.has(a.path));
  if (alternates.some((a) => a.path && a.path !== page.path)) {
    for (const a of alternates) parts.push(`<xhtml:link rel="alternate" hreflang="${escapeXml(a.hreflang)}" href="${escapeXml(a.href)}"/>`);
  }
  for (const img of images.slice(0, 1000)) parts.push(`<image:image><image:loc>${escapeXml(img)}</image:loc></image:image>`);
  if (withVideo) for (const v of videoEntries(page)) parts.push(v);
  return { lastmod, xml: `<url>${parts.join('')}</url>` };
}

/** Video entries for a page whose main content is a YouTube film (its VideoObject JSON-LD). */
function videoEntries(page) {
  return page.videos
    .filter((v) => /youtube(-nocookie)?\.com\/embed\//.test(v.embedUrl ?? ''))
    .map((v) => {
      const thumb = [].concat(v.thumbnailUrl ?? [])[0];
      if (!thumb || !v.name) return '';
      const description = String(v.description || v.name).slice(0, 2048);
      const parts = [
        `<video:thumbnail_loc>${escapeXml(thumb)}</video:thumbnail_loc>`,
        `<video:title>${escapeXml(String(v.name).slice(0, 100))}</video:title>`,
        `<video:description>${escapeXml(description)}</video:description>`,
        `<video:player_loc>${escapeXml(v.embedUrl)}</video:player_loc>`,
      ];
      const seconds = isoDurationSeconds(v.duration);
      if (seconds) parts.push(`<video:duration>${seconds}</video:duration>`);
      if (v.uploadDate) parts.push(`<video:publication_date>${escapeXml(v.uploadDate)}</video:publication_date>`);
      return `<video:video>${parts.join('')}</video:video>`;
    })
    .filter(Boolean);
}

function isoDurationSeconds(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? '');
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}
