#!/usr/bin/env node
// scripts/seo-check.mjs — zero-dependency SEO audit of the built site.
// Usage: SITE_ENV=production npm run build && node scripts/seo-check.mjs [distDir]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = process.argv[2] ?? 'dist';
const errors = [];
const warnings = [];
const err = (f, m) => errors.push(`${f}: ${m}`);
const warn = (f, m) => warnings.push(`${f}: ${m}`);

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') ? [p] : [];
});

// Backreference: Astro leaves ' unescaped inside "…" (content="we've …").
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'is'))?.[2];
const tags = (html, re) => html.match(re) ?? [];
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// Thai vowel/tone marks above and below the line take no width: don't count them toward title/description length.
const width = (s) => s.replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, '').length;
// Paths compared decoded: links may carry raw Thai letters, uppercase or lowercase percent-encoding for the same URL.
const decodePath = (p) => { try { return decodeURI(p); } catch { return p; } };
const SITEMAPS = ['sitemap-index.xml', 'sitemap.xml', 'sitemap_index.xml']; // sitemap_index.xml: name kept from WordPress

const files = walk(DIST);
const titles = new Map();
const descs = new Map();
const canonicals = new Map();     // canonical URL -> file
const hreflangs = new Map();      // canonical URL -> Set(alternate URLs)
const linked = new Set();          // internal paths linked from pages
let origin = null;
let noindexCount = 0;

for (const file of files) {
  const rel = relative(DIST, file).split(sep).join('/');
  if (rel === '404.html' || rel.endsWith('/404.html')) continue;
  const html = readFileSync(file, 'utf8');
  const head = html.split(/<\/head>/i)[0];

  const robotsTag = tags(head, /<meta[^>]+name=["']robots["'][^>]*>/gi);
  if (robotsTag.length > 1) err(rel, 'multiple robots meta tags');
  const robots = robotsTag[0] ? attr(robotsTag[0], 'content') ?? '' : '';
  const noindex = /noindex/i.test(robots);
  if (noindex) noindexCount++;
  if (/<meta[^>]+http-equiv=["']refresh/i.test(head)) { warn(rel, 'meta refresh redirect page (use _redirects 301)'); continue; }

  const titleTags = tags(head, /<title>[\s\S]*?<\/title>/gi);
  if (titleTags.length !== 1) err(rel, `${titleTags.length} <title> tags`);
  const title = decode((titleTags[0] ?? '').replace(/<\/?title>/gi, '').trim());
  if (!title) err(rel, 'empty title');
  else if (width(title) > 65) warn(rel, `title ${width(title)} chars: "${title}"`);
  else if (width(title) < 25) warn(rel, `title short (${width(title)}): "${title}"`);

  const descTag = tags(head, /<meta[^>]+name=["']description["'][^>]*>/gi);
  if (descTag.length !== 1) err(rel, `${descTag.length} meta descriptions`);
  const desc = decode(descTag[0] ? attr(descTag[0], 'content') ?? '' : '');
  if (descTag.length && !desc) err(rel, 'empty meta description');
  else if (desc && (width(desc) < 70 || width(desc) > 165)) warn(rel, `description ${width(desc)} chars`);

  const canTags = tags(head, /<link[^>]+rel=["']canonical["'][^>]*>/gi);
  if (canTags.length !== 1) err(rel, `${canTags.length} canonical tags`);
  const canonical = canTags[0] ? attr(canTags[0], 'href') : null;
  if (canonical) {
    if (!/^https:\/\//.test(canonical)) err(rel, `canonical not absolute https: ${canonical}`);
    if (/[?#]/.test(canonical)) err(rel, `canonical has query/hash: ${canonical}`);
    origin ??= new URL(canonical).origin;
    if (new URL(canonical).origin !== origin) err(rel, `canonical host differs: ${canonical}`);
  }

  if (!/<html[^>]+lang=["'][^"']+["']/i.test(html)) err(rel, 'missing <html lang>');
  if (!/<meta[^>]+name=["']viewport["']/i.test(head)) err(rel, 'missing viewport meta');
  if (!/property=["']og:image["']/i.test(head)) warn(rel, 'missing og:image');
  if (!/property=["']og:title["']/i.test(head)) warn(rel, 'missing og:title');

  const h1 = tags(html, /<h1[\s>]/gi).length;
  if (h1 !== 1) err(rel, `${h1} <h1> tags`);

  // JSON-LD must parse
  for (const block of tags(html, /<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi)) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    try { JSON.parse(json); } catch { err(rel, 'invalid JSON-LD'); }
  }
  if (!/application\/ld\+json/i.test(html) && !noindex) warn(rel, 'no JSON-LD');

  // images
  for (const img of tags(html, /<img\b[^>]*>/gi)) {
    // Astro renders alt="" as a bare `alt`, which counts as present.
    if (!/\salt(\s*=|[\s>/])/i.test(img)) err(rel, `img without alt: ${attr(img, 'src') ?? ''}`);
    if (!attr(img, 'width') || !attr(img, 'height')) warn(rel, `img without width/height: ${attr(img, 'src') ?? ''}`);
  }

  // hreflang
  const alts = tags(head, /<link[^>]+rel=["']alternate["'][^>]+hreflang=[^>]*>/gi).map((t) => attr(t, 'href'));
  if (canonical && alts.length) {
    if (!alts.includes(canonical)) err(rel, 'hreflang set does not include self (canonical)');
    hreflangs.set(canonical, new Set(alts));
  }

  // internal links
  for (const a of tags(html, /<a\b[^>]*href=["'][^"']+["'][^>]*>/gi)) {
    const href = attr(a, 'href');
    if (!href || /^(mailto:|tel:|#|javascript:)/i.test(href)) continue;
    let u;
    try { u = new URL(href, canonical ?? 'https://x.invalid/'); } catch { continue; }
    if (origin && u.origin !== origin && !href.startsWith('/')) continue;
    linked.add(decodePath(u.pathname));
  }

  if (noindex) continue; // duplicates only matter for indexable pages
  if (title) titles.set(title, [...(titles.get(title) ?? []), rel]);
  if (desc) descs.set(desc, [...(descs.get(desc) ?? []), rel]);
  if (canonical) {
    if (canonicals.has(canonical)) err(rel, `same canonical as ${canonicals.get(canonical)}`);
    canonicals.set(canonical, rel);
  }
}

for (const [t, fs] of titles) if (fs.length > 1) err(fs.join(', '), `duplicate title "${t}"`);
for (const [d, fs] of descs) if (fs.length > 1) err(fs.join(', '), `duplicate description`);

// hreflang reciprocity
for (const [page, set] of hreflangs) {
  for (const alt of set) {
    if (alt === page) continue;
    const back = hreflangs.get(alt);
    if (!back) err(page, `hreflang target has no hreflang set / not found: ${alt}`);
    else if (!back.has(page)) err(page, `hreflang not reciprocal with ${alt}`);
  }
}

// orphan pages (indexable pages nobody links to)
for (const [url, rel] of canonicals) {
  const path = decodePath(new URL(url).pathname);
  if (path !== '/' && !linked.has(path)) warn(rel, `orphan page (no internal links): ${path}`);
}

// site files
for (const f of ['robots.txt', '404.html']) if (!existsSync(join(DIST, f))) err(f, 'missing');
if (!SITEMAPS.some((f) => existsSync(join(DIST, f)))) err('sitemap', `missing sitemap (${SITEMAPS.join(' / ')})`);
if (existsSync(join(DIST, 'robots.txt'))) {
  const robots = readFileSync(join(DIST, 'robots.txt'), 'utf8');
  if (/Disallow:\s*\/\s*$/m.test(robots) && /User-agent:\s*\*/i.test(robots) && !/Allow:\s*\/\s*$/m.test(robots))
    warn('robots.txt', 'blocks everything — expected only on preview builds (build with SITE_ENV=production)');
  if (!/^Sitemap:/mi.test(robots)) err('robots.txt', 'no Sitemap: line');
}

console.log(`Checked ${files.length} HTML files in ${DIST}, ${noindexCount} noindex`); // ≈ all of them = not a production build
warnings.forEach((w) => console.log('⚠ ', w));
errors.forEach((e) => console.log('✖ ', e));
console.log(`${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
