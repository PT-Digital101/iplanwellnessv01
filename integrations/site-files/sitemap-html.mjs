// Fills the HTML sitemap pages (/sitemap/ and /<locale>/sitemap/, src/components/SitemapPage.astro) with every
// built page, grouped by section. Each language's sitemap lists the pages in that language. The sitemaps of the other
// languages also list, outside the "blog" group, the default-language pages that have no version in their language
// yet (marked with the language code). Groups, sections and labels: htmlSitemap in migration.config.json.
import fs from 'node:fs';
import { escapeHtml, localeOf, stripLocale } from './util.mjs';
import { indexable } from './sitemap-xml.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Link text: the page title without the site name (and WordPress's " Archives"), or the H1 when the title
 *  is much longer or is an old theme's placeholder title. */
function label(page, lang, o) {
  if (o.homes.has(page.path)) return o.homeLabels[lang] ?? o.homeLabels[o.defaultLocale] ?? page.title;
  const h1 = page.h1Title || page.h1;
  let t = page.title;
  if (o.siteName) t = t.replace(o.siteName, '');
  t = t.replace(/\s*[-–—|:@/]+\s*$/, '').replace(/\s+Archives$/i, '').trim();
  if (!t || o.placeholders.some((re) => re.test(t))) t = h1 || page.title;
  if (h1 && t.length > 70 && h1.length < t.length) t = h1;
  return t;
}

export function fillHtmlSitemaps({ pages, locales, settings, log = () => {} }) {
  const cfg = settings.htmlSitemap;
  const GROUPS = cfg.groups;
  const SECTION = cfg.sections ?? {}; // first segment of the default-language path -> group key
  const LEADS = new Set(cfg.leads ?? []); // index and archive sections, listed first in their group
  const NESTED_LEADS = new Set(cfg.nestedLeads ?? []); // archive sections whose nested pages are leads too
  const fallback = GROUPS[0].key;
  const all = [locales.default, ...locales.prefixed];
  const prefix = (l) => (l === locales.default ? '/' : `/${l}/`);
  const names = settings.oldSite?.siteNames ?? [];
  const o = {
    defaultLocale: locales.default,
    homes: new Set(all.map(prefix)),
    homeLabels: cfg.homeLabels ?? {},
    // " - Site Name", " | Site Name", "@ Site Name" at the end of a title.
    siteName: names.length ? new RegExp(`\\s*[-–—|:@]\\s*(?:${names.map(escapeRe).join('|')})\\s*$`, 'i') : null,
    placeholders: (cfg.placeholderTitles ?? []).map((t) => new RegExp(t, 'i')),
  };

  const byPath = new Map(pages.map((p) => [p.path, p]));
  const twin = (page, lang) => page.alternates.find((a) => a.hreflang === lang && a.path && a.path !== page.path && byPath.has(a.path))?.path;
  const sitemapPaths = new Set(all.map((l) => `${prefix(l)}sitemap/`));

  const entries = [];
  for (const page of pages) {
    if (!indexable(page) || /\/page\/\d+\/$/.test(page.path) || sitemapPaths.has(page.path)) continue;
    const lang = all.includes(page.lang) ? page.lang : localeOf(page.path, locales);
    const defPath = lang === locales.default ? page.path : (twin(page, locales.default) ?? stripLocale(page.path, locales));
    const seg = defPath.split('/').filter(Boolean);
    const post = page.types.has('BlogPosting');
    const group = o.homes.has(page.path) ? fallback : post ? 'blog' : (SECTION[seg[0]] ?? fallback);
    const lead = !post && LEADS.has(seg[0]) && (seg.length === 1 || NESTED_LEADS.has(seg[0]));
    const has = new Set(all.filter((l) => l === lang || twin(page, l)));
    entries.push({ page, lang, group, lead, depth: seg.length, has });
  }

  const filled = {};
  for (const lang of all) {
    const target = pages.find((p) => p.path === `${prefix(lang)}sitemap/`);
    if (!target) continue;
    const list = entries.filter((e) => e.lang === lang || (lang !== locales.default && e.lang === locales.default && !e.has.has(lang) && e.group !== 'blog'));
    const html = render(list, lang, GROUPS, cfg.tocLabels ?? {}, o);
    const before = fs.readFileSync(target.file, 'utf8');
    const after = before.replace(/<div[^>]*\bdata-sitemap-groups="[\w-]+"[^>]*>[\s\S]*?<\/div>/, html);
    if (after === before) {
      log(`HTML sitemap ${target.path}: placeholder not found, left as it is`);
      continue;
    }
    fs.writeFileSync(target.file, after);
    filled[target.path] = list.length;
  }
  return filled;
}

function render(list, lang, GROUPS, tocLabels, o) {
  const collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
  const sections = [];
  const toc = [];
  for (const g of GROUPS) {
    const items = list.filter((e) => e.group === g.key).map((e) => ({ ...e, text: label(e.page, lang, o) }));
    if (!items.length) continue;
    // Pages that share a title on the old site are told apart by their H1.
    const seen = new Map();
    for (const e of items) seen.set(e.text, (seen.get(e.text) ?? 0) + 1);
    for (const e of items) if (seen.get(e.text) > 1 && (e.page.h1Title || e.page.h1)) e.text = e.page.h1Title || e.page.h1;
    // Leads: section index first (shortest path), then the archives by name. Then the rest by name.
    const leads = items.filter((e) => e.lead).sort((a, b) => a.depth - b.depth || collator.compare(a.text, b.text));
    const rest = items.filter((e) => !e.lead).sort((a, b) => collator.compare(a.text, b.text));
    const li = (e) => {
      const other = e.lang !== lang;
      const attrs = other ? ` hreflang="${e.lang}" lang="${e.lang}"` : '';
      return `<li><a href="${escapeHtml(encodeURI(e.page.path))}"${attrs}>${escapeHtml(e.text)}</a>${other ? `<span class="sm-lang">${e.lang.toUpperCase()}</span>` : ''}</li>`;
    };
    const id = g.key.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const name = g.labels[lang] ?? g.labels[o.defaultLocale] ?? g.key;
    toc.push(`<li><a href="#${id}">${escapeHtml(name)}</a></li>`);
    sections.push(
      `<section class="sm-group" id="${id}" aria-labelledby="${id}-h">` +
        `<h2 class="sm-h2" id="${id}-h">${escapeHtml(name)}<span class="sm-count">${items.length}</span></h2>` +
        `<div class="sm-body">` +
        (leads.length ? `<ul class="sm-list sm-list--lead">${leads.map(li).join('')}</ul>` : '') +
        (rest.length ? `<ul class="sm-list">${rest.map(li).join('')}</ul>` : '') +
        `</div></section>`,
    );
  }
  const tocLabel = tocLabels[lang] ?? tocLabels[o.defaultLocale] ?? 'Sections on this page';
  return `<div class="sm-groups"><nav aria-label="${tocLabel}"><ul class="sm-toc">${toc.join('')}</ul></nav>${sections.join('')}</div>`;
}
