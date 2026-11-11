// Reads every built page in dist/ once: the head tags the sitemaps and checks need, the images and videos in <main>.
import fs from 'node:fs';
import path from 'node:path';
import { decodeEntities, sitePath, tags, textOf, walk } from './util.mjs';

/**
 * @typedef {object} Page
 * @property {string} path      Decoded URL path with trailing slash, e.g. /บริการ/ or /en/services/
 * @property {string} file      Absolute path of the HTML file
 * @property {'en'|'th'|string} lang
 * @property {string} title
 * @property {string} h1        Text of the first H1
 * @property {string} h1Title   Text of a <span class="h1-title"> inside the H1 (its title when the H1 also holds a kicker line)
 * @property {string} canonical Canonical URL exactly as the page prints it
 * @property {boolean} selfCanonical
 * @property {boolean} noindex  Page-level noindex (data-noindex, or "noindex" in a production build)
 * @property {{hreflang: string, href: string, path: string|null}[]} alternates
 * @property {string[]} images  Absolute URLs: og:image and the <img> elements in <main>
 * @property {string|undefined} ogImage
 * @property {object[]} videos  VideoObject entries from the page's JSON-LD
 * @property {Set<string>} types JSON-LD @type values
 */

/** @returns {Page[]} */
export function scanPages(distDir, site, { production = false } = {}) {
  const files = walk(distDir, (rel, e) => e.isDirectory() && (rel === '_astro' || rel === 'wp-content')).filter(
    (f) => f === 'index.html' || f.endsWith('/index.html'),
  );
  return files.map((rel) => readPage(path.join(distDir, rel), '/' + rel.replace(/index\.html$/, ''), site, production)).sort((a, b) => a.path.localeCompare(b.path));
}

function readPage(file, pagePath, site, production) {
  const html = fs.readFileSync(file, 'utf8');
  const head = html.slice(0, html.indexOf('</head>') + 1 || html.length);
  const links = tags(head, 'link');
  const metas = tags(head, 'meta');
  const robotsTag = metas.find((m) => m.name === 'robots');
  const canonical = links.find((l) => l.rel === 'canonical')?.href ?? '';
  const meta = (key) => metas.find((m) => m.property === key || m.name === key)?.content;

  const mainStart = html.search(/<main\b/);
  const mainEnd = html.lastIndexOf('</main>');
  const main = mainStart >= 0 && mainEnd > mainStart ? html.slice(mainStart, mainEnd) : '';

  const jsonLd = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]);
      for (const d of Array.isArray(data) ? data : data['@graph'] ?? [data]) jsonLd.push(d);
    } catch {
      /* not ours to fix here */
    }
  }
  const types = new Set(jsonLd.flatMap((d) => [].concat(d['@type'] ?? [])));

  const images = [];
  const addImage = (src) => {
    if (!src || src.startsWith('data:')) return undefined;
    try {
      const abs = new URL(src, site).href;
      if (!images.includes(abs)) images.push(abs);
      return abs;
    } catch {
      return undefined;
    }
  };
  const ogImage = addImage(meta('og:image'));
  for (const img of tags(main, 'img')) addImage(img.src);

  const h1 = main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/) ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/);

  return {
    path: pagePath,
    file,
    lang: html.match(/<html[^>]*\slang="([^"]+)"/)?.[1] ?? 'en',
    title: decodeEntities(head.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim(),
    h1: h1 ? textOf(h1[1]) : '',
    h1Title: h1 ? textOf(h1[1].match(/class="[^"]*\bh1-title\b[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '') : '',
    description: meta('description') ?? '',
    canonical,
    selfCanonical: sitePath(canonical, site) === pagePath,
    noindex: !!robotsTag && ('data-noindex' in robotsTag || (production && /noindex/i.test(robotsTag.content ?? ''))),
    alternates: links
      .filter((l) => l.rel === 'alternate' && l.hreflang)
      .map((l) => ({ hreflang: l.hreflang, href: l.href, path: sitePath(l.href, site) })),
    images,
    ogImage,
    videos: jsonLd.filter((d) => [].concat(d['@type']).includes('VideoObject')),
    types,
    youtube: [...new Set([...main.matchAll(/data-youtube="([\w-]{6,})"/g)].map((m) => m[1]))],
  };
}
