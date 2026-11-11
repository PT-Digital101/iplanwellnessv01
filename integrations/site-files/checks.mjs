// Checks of the finished dist/: redirects, XML sitemaps and Cloudflare's static asset limits.
// Used at the end of the build (summary in the log) and by scripts/check-dist.mjs (fails on errors).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scanPages } from './pages.mjs';
import { MAX_LINE, MAX_STATIC_RULES } from './redirects.mjs';
import { indexable } from './sitemap-xml.mjs';
import { decodePath, sitePath, walk } from './util.mjs';

/** Workers static assets, free plan (developers.cloudflare.com/workers/platform/limits, checked 4 October 2026). */
export const LIMITS = { files: 20000, fileBytes: 25 * 1024 * 1024 };
/** Not uploaded as assets (wrangler reads them as configuration). */
const META_FILES = new Set(['_redirects', '_headers', '.assetsignore']);

export function checkDist({ distDir, site, production = false, pages = null }) {
  const errors = [];
  const warnings = [];
  const stats = {};
  pages ??= scanPages(distDir, site, { production });
  const pageSet = new Set(pages.map((p) => p.path));
  const byPath = new Map(pages.map((p) => [p.path, p]));

  // Files and limits.
  const all = walk(distDir).filter((f) => !META_FILES.has(f));
  const fileSet = new Set(all.filter((f) => !f.endsWith('index.html')).map((f) => '/' + f));
  let total = 0;
  let largest = { file: '', bytes: 0 };
  for (const f of all) {
    const bytes = fs.statSync(path.join(distDir, f)).size;
    total += bytes;
    if (bytes > largest.bytes) largest = { file: f, bytes };
    if (bytes > LIMITS.fileBytes) errors.push(`file over 25 MiB: ${f} (${(bytes / 1048576).toFixed(1)} MiB)`);
  }
  if (all.length > LIMITS.files) errors.push(`${all.length} files, over the limit of ${LIMITS.files}`);
  stats.files = all.length;
  stats.bytes = total;
  stats.largest = largest;
  stats.uploads = all.filter((f) => f.startsWith('wp-content/uploads/')).length;
  stats.pages = pages.length;

  // Redirects.
  const redirectsFile = path.join(distDir, '_redirects');
  const sources = new Map();
  if (!fs.existsSync(redirectsFile)) errors.push('dist/_redirects is missing');
  else {
    const lines = fs.readFileSync(redirectsFile, 'utf8').split('\n');
    const groups = {};
    let group = '';
    for (const raw of lines) {
      const line = raw.trim();
      const g = line.match(/^# ([\w-]+): (\d+) URLs, (\d+) rules/);
      if (g) {
        group = g[1];
        groups[group] = { urls: +g[2], rules: +g[3] };
      }
      if (!line || line.startsWith('#')) continue;
      if (line.length > MAX_LINE) errors.push(`redirect line over ${MAX_LINE} characters: ${line.slice(0, 80)}…`);
      const [from, to, status] = line.split(/\s+/);
      if (sources.has(from)) errors.push(`duplicate redirect source ${from}`);
      sources.set(from, { to, status, group });
    }
    stats.redirectRules = sources.size;
    stats.redirectGroups = groups;
    if (sources.size > MAX_STATIC_RULES) errors.push(`${sources.size} redirect rules, over the limit of ${MAX_STATIC_RULES} static rules`);
    const decodedSources = new Set([...sources.keys()].map(decodePath));
    const missing = new Map(); // target -> sources (decoded, without the slash variants)
    for (const [from, { to, status }] of sources) {
      const dFrom = decodePath(from);
      if (status !== '301') errors.push(`redirect ${from} has status ${status}`);
      if (/[*:]/.test(from)) warnings.push(`dynamic redirect rule ${from}`);
      if (pageSet.has(dFrom) || fileSet.has(dFrom)) errors.push(`redirect source is a built page: ${dFrom}`);
      if (/^https?:/.test(to)) continue;
      const dTo = decodePath(to.split('?')[0]);
      if (!pageSet.has(dTo) && !fileSet.has(dTo)) missing.set(dTo, new Set([...(missing.get(dTo) ?? []), dFrom.replace(/\/$/, '')]));
      if (decodedSources.has(dTo)) errors.push(`redirect chain: ${dFrom} → ${dTo}, which redirects again`);
      if ((to.match(/%[0-9A-Fa-f]{2}/g) ?? []).some((m) => m !== m.toUpperCase())) errors.push(`redirect target with lowercase percent-encoding (one more hop on Cloudflare): ${to}`);
    }
    for (const [to, from] of missing) {
      const list = [...from];
      errors.push(`redirect target not built: ${to} (from ${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''})`);
    }
    stats.redirectTargetsMissing = missing.size;
    // Both forms of every source.
    let oneForm = 0;
    for (const s of decodedSources) {
      if (/\.\w+$/.test(s)) continue;
      const other = s.endsWith('/') ? s.slice(0, -1) : s + '/';
      if (!decodedSources.has(other) && !pageSet.has(other)) oneForm++;
    }
    if (oneForm) warnings.push(`${oneForm} redirect sources match only with or only without the trailing slash`);
  }

  // XML sitemaps.
  const redirectPaths = new Set([...sources.keys()].map(decodePath));
  const indexFile = path.join(distDir, 'sitemap_index.xml');
  const listed = new Map();
  if (!fs.existsSync(indexFile)) errors.push('dist/sitemap_index.xml is missing');
  else {
    const xmlFiles = ['sitemap_index.xml'];
    const index = fs.readFileSync(indexFile, 'utf8');
    const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    stats.sitemaps = {};
    for (const child of children) {
      const file = new URL(child).pathname.slice(1);
      xmlFiles.push(file);
      if (!fs.existsSync(path.join(distDir, file))) {
        errors.push(`sitemap index lists ${child}, which is not in dist/`);
        continue;
      }
      const xml = fs.readFileSync(path.join(distDir, file), 'utf8');
      const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
      stats.sitemaps[file] = { urls: urls.length, images: 0, videos: 0, alternates: 0 };
      for (const u of urls) {
        const loc = u.match(/<loc>([^<]+)<\/loc>/)?.[1].replace(/&amp;/g, '&');
        const p = sitePath(loc, site);
        const page = byPath.get(p);
        if (listed.has(p)) errors.push(`${p} is in two sitemaps (${listed.get(p)}, ${file})`);
        listed.set(p, file);
        if (!page) errors.push(`sitemap URL is not a built page: ${loc}`);
        else {
          if (!indexable(page)) errors.push(`sitemap URL is noindex or canonical elsewhere: ${loc}`);
          if (page.canonical !== loc) errors.push(`sitemap URL differs from the page's canonical: ${loc} vs ${page.canonical}`);
        }
        if (redirectPaths.has(p)) errors.push(`sitemap URL is a redirect source: ${loc}`);
        const lastmod = u.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
        if (lastmod && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z))?$/.test(lastmod)) errors.push(`bad lastmod ${lastmod} for ${loc}`);
        for (const m of u.matchAll(/<xhtml:link [^>]*href="([^"]+)"/g)) {
          stats.sitemaps[file].alternates++;
          const ap = sitePath(m[1].replace(/&amp;/g, '&'), site);
          if (!pageSet.has(ap)) errors.push(`hreflang twin of ${p} is not built: ${m[1]}`);
        }
        for (const m of u.matchAll(/<image:loc>([^<]+)<\/image:loc>/g)) {
          stats.sitemaps[file].images++;
          const ip = sitePath(m[1].replace(/&amp;/g, '&'), site);
          if (ip && !fileSet.has(ip)) errors.push(`sitemap image not in dist/: ${m[1]}`);
        }
        stats.sitemaps[file].videos += (u.match(/<video:video>/g) ?? []).length;
      }
    }
    for (const page of pages) if (indexable(page) && !listed.has(page.path)) errors.push(`indexable page missing from the sitemaps: ${page.path}`);
    // The pages' own hreflang tags (the sitemap leaves out twins that aren't built).
    for (const page of pages) {
      for (const a of page.alternates) if (a.path && !pageSet.has(a.path)) errors.push(`hreflang on ${page.path} points to a page that is not built: ${a.path}`);
    }
    for (const f of xmlFiles) {
      const problem = xmlProblem(path.join(distDir, f));
      if (problem) errors.push(`${f} is not well-formed XML: ${problem}`);
    }
  }
  stats.sitemapUrls = listed.size;
  return { errors, warnings, stats };
}

/** xmllint when the system has it, otherwise a tag-balance check. Returns a message or ''. */
function xmlProblem(file) {
  try {
    execFileSync('xmllint', ['--noout', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return '';
  } catch (e) {
    if (e.code !== 'ENOENT') return String(e.stderr || e.message).split('\n')[0];
  }
  const xml = fs.readFileSync(file, 'utf8').replace(/^<\?xml[^>]*\?>/, '');
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(xml)) return 'unescaped &';
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([\w:.-]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return `unbalanced </${m[2]}>`;
  }
  return stack.length ? `unclosed <${stack.at(-1)}>` : '';
}
