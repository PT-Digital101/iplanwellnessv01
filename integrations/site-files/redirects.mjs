// Writes dist/_redirects: every old URL that redirects today or should redirect now, in one hop to a built page.
// Sources (docs/MIGRATION.md): inventory/redirects.csv (the old site), every CSV in inventory/redirects-todo/,
// the paginated archive URLs in inventory/urls.json, short URLs of nested pages, and the old sitemap file names
// (redirects.oldSitemaps in migration.config.json). Missing inventory files are skipped.
// Rules whose source is now a built page are dropped, chains are followed to the end, and each source is written
// with and without its trailing slash and, for non-ASCII letters (Thai…), with uppercase and lowercase
// percent-encoding.
import fs from 'node:fs';
import path from 'node:path';
import { decodePath, encodePath, isAscii, lowerHex, readCsv } from './util.mjs';

export const MAX_STATIC_RULES = 2000;
export const MAX_LINE = 1000;

/**
 * @param {object} o
 * @param {string} o.root     repo root
 * @param {string} o.distDir
 * @param {Set<string>} o.pages decoded paths of built pages
 * @param {Set<string>} o.files decoded paths of every other file in dist (e.g. /sitemap_index.xml)
 * @param {{default: string, prefixed: string[]}} o.locales
 * @param {object} o.settings migration.config.json
 */
export function buildRedirects({ root, distDir, pages, files, locales, settings }) {
  // Sitemap file names of the WordPress site that this build doesn't write.
  const OLD_SITEMAPS = settings.redirects?.oldSitemaps ?? {};
  // Top-level sections whose nested pages don't get a short /<slug>/ rule (they are not WordPress pages).
  const NOT_PAGES = new Set(settings.redirects?.noShortUrls ?? []);
  const inv = (...p) => path.join(root, 'inventory', ...p);
  const candidates = [];
  const add = (group, from, to, note = '') => {
    if (!from || !to) return;
    from = normalizeSource(from);
    to = /^https?:/.test(to) ? to : decodePath(to);
    if (from !== to) candidates.push({ group, from, to, note });
  };

  // 1. Hand-mapped lost URLs first (redirects-todo/lost-urls.csv): they correct old redirects that end in a 404 today.
  const todoDir = inv('redirects-todo');
  const todo = fs.existsSync(todoDir) ? fs.readdirSync(todoDir).filter((f) => f.endsWith('.csv')).sort() : [];
  const ordered = [...todo.filter((f) => f === 'lost-urls.csv'), null, ...todo.filter((f) => f !== 'lost-urls.csv')];
  for (const f of ordered) {
    if (f === null) {
      // 2. Everything that redirects on the old site today, to its final URL.
      if (!fs.existsSync(inv('redirects.csv'))) continue;
      for (const r of readCsv(inv('redirects.csv'))) {
        if (r.status !== '301' || r.final_status !== '200') continue;
        add('live', new URL(r.from_decoded).pathname, new URL(r.final_url).pathname);
      }
      continue;
    }
    // 3. The other lists in redirects-todo/ (tags, removed pages, ...), one group per file.
    for (const r of readCsv(path.join(todoDir, f))) add(f.replace(/\.csv$/, ''), r.from, r.to, r.note);
  }

  // 4. Paginated archives that are not built go to their first page.
  const urls = fs.existsSync(inv('urls.json')) ? JSON.parse(fs.readFileSync(inv('urls.json'), 'utf8')).urls : [];
  for (const r of urls) {
    if (r.type !== 'pagination') continue;
    const p = decodePath(new URL(r.url).pathname);
    if (!pages.has(p)) add('pagination', p, p.replace(/page\/\d+\/$/, ''));
  }

  // 5. Short URLs: WordPress sends /<slug>/ to the page with that slug wherever it sits (/team/ to
  //    /about/team/). A static site can't guess, so each nested page gets its rule.
  const bySlug = new Map();
  for (const p of pages) {
    const seg = p.split('/').filter(Boolean);
    const prefixed = locales.prefixed.includes(seg[0]);
    const rest = prefixed ? seg.slice(1) : seg;
    if (rest.length < 2 || NOT_PAGES.has(rest[0]) || /^\d+$/.test(rest.at(-1))) continue;
    const short = `${prefixed ? '/' + seg[0] : ''}/${rest.at(-1)}/`;
    bySlug.set(short, [...(bySlug.get(short) ?? []), p]);
  }
  for (const [short, targets] of bySlug) if (targets.length === 1) add('short-urls', short, targets[0]);

  // 6. Old sitemap addresses.
  for (const [from, to] of Object.entries(OLD_SITEMAPS)) add('sitemaps', from, to);

  // Drop rules whose source is a built page or file; keep the first rule for each source.
  const rules = new Map();
  const dropped = [];
  for (const c of candidates) {
    const slashless = c.from.replace(/\/$/, '');
    if (pages.has(c.from) || files.has(c.from) || (c.from.endsWith('/') && files.has(slashless))) {
      dropped.push({ ...c, reason: 'source is a built page' });
    } else if (rules.has(c.from)) {
      if (rules.get(c.from).to !== c.to) dropped.push({ ...c, reason: `source already redirects to ${rules.get(c.from).to} (${rules.get(c.from).group})` });
    } else rules.set(c.from, c);
  }

  // Follow chains to the final URL; a loop drops the rule.
  const problems = [];
  for (const r of rules.values()) {
    const seen = [r.from];
    let to = r.to;
    while (rules.has(normalizeSource(to)) && !seen.includes(normalizeSource(to))) {
      seen.push(normalizeSource(to));
      to = rules.get(normalizeSource(to)).to;
    }
    if (seen.includes(normalizeSource(to))) {
      problems.push({ ...r, reason: `loop: ${seen.join(' → ')}` });
      r.loop = true;
    }
    r.final = to;
  }

  // Target check: a built page, a file in dist/ or another site.
  const missing = [];
  for (const r of rules.values()) {
    if (r.loop) continue;
    if (!/^https?:/.test(r.final) && !pages.has(r.final) && !files.has(r.final)) missing.push(r);
  }

  // Write every form of each source.
  const lines = [];
  const seen = new Set();
  const counts = {};
  const groups = [...new Set([...rules.values()].map((r) => r.group))];
  for (const group of groups) {
    const block = [];
    for (const r of rules.values()) {
      if (r.group !== group || r.loop) continue;
      const to = /^https?:/.test(r.final) ? r.final : encodePath(r.final);
      for (const from of sourceForms(r.from, pages, files)) {
        if (seen.has(from)) continue;
        seen.add(from);
        block.push(`${from} ${to} 301`);
      }
      counts[group] = (counts[group] ?? 0) + 1;
    }
    if (block.length) lines.push('', `# ${group}: ${counts[group]} URLs, ${block.length} rules`, ...block);
  }
  const header = [
    '# Generated by integrations/site-files/redirects.mjs at build time. Do not edit: change the CSV files in',
    '# inventory/redirects-todo/ (or inventory/redirects.csv) and rebuild. See docs/MIGRATION.md.',
    `# ${seen.size} static rules (limit ${MAX_STATIC_RULES}).`,
  ];
  const text = [...header, ...lines, ''].join('\n');
  fs.writeFileSync(path.join(distDir, '_redirects'), text);

  return { rules: [...rules.values()], ruleLines: seen.size, counts, dropped, missing, problems };
}

/** /a/b -> /a/b, /a/b/ -> /a/b/ (decoded, leading slash, no query). */
function normalizeSource(p) {
  p = decodePath(p.split('?')[0].split('#')[0]);
  return p.startsWith('/') ? p : '/' + p;
}

/** The request paths that should match a decoded source: with and without the trailing slash, and for non-ASCII
 *  paths both percent-encodings (browsers send uppercase hex; WordPress printed lowercase in its links). */
function sourceForms(from, pages, files) {
  const variants = [from];
  if (from.length > 1 && !/\.\w+$/.test(from)) variants.push(from.endsWith('/') ? from.slice(0, -1) : from + '/');
  const out = [];
  for (const v of variants) {
    if (pages.has(v) || files.has(v)) continue;
    const enc = encodePath(v);
    out.push(enc);
    if (!isAscii(v)) out.push(lowerHex(enc));
  }
  return out;
}
