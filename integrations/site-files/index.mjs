// Astro integration: the files the site needs beyond its pages, written after every build from dist/ itself, so
// pages added later are picked up without edits (docs/MIGRATION.md). Per-site settings: migration.config.json.
//   1. the HTML sitemaps (/sitemap/ and /<locale>/sitemap/) get their page lists (sitemap-html.mjs)
//   2. images in use are copied to their old /wp-content/uploads/ addresses (uploads.mjs)
//   3. /sitemap_index.xml and its child sitemaps (sitemap-xml.mjs)
//   4. dist/_redirects (redirects.mjs)
//   5. checks of the result, printed as a summary (checks.mjs; npm run check:dist fails on errors)
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkDist } from './checks.mjs';
import { lastmodResolver } from './lastmod.mjs';
import { scanPages } from './pages.mjs';
import { buildRedirects } from './redirects.mjs';
import { fillHtmlSitemaps } from './sitemap-html.mjs';
import { buildXmlSitemaps } from './sitemap-xml.mjs';
import { copyOldImages } from './uploads.mjs';
import { decodePath, readConfig, walk } from './util.mjs';

/**
 * @param {object} [options]
 * @param {string|null} [options.editsAfter] ISO date (the switch): git commits after it override WordPress dates in <lastmod>
 */
export default function siteFiles(options = {}) {
  let root = process.cwd();
  let site = '';
  let routes = [];
  // The site's languages, from Astro's i18n config: the default one at the root, the others under /<locale>/.
  let locales = { default: 'en', prefixed: [] };
  // sha1 of each image the build emitted -> its file names in _astro/ (to tell which src/assets images are in use).
  const emitted = new Map();

  return {
    name: 'site-files',
    hooks: {
      'astro:config:setup': ({ config, updateConfig }) => {
        root = fileURLToPath(config.root);
        site = String(config.site).replace(/\/$/, '');
        const i18n = config.i18n;
        if (i18n) {
          const codes = i18n.locales.map((l) => (typeof l === 'string' ? l : l.path));
          locales = { default: i18n.defaultLocale, prefixed: codes.filter((l) => l !== i18n.defaultLocale) };
        }
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'site-files:emitted-images',
                apply: 'build',
                generateBundle(_, bundle) {
                  for (const item of Object.values(bundle)) {
                    if (item.type !== 'asset' || !/\.(jpe?g|png|webp|gif|svg|avif)$/i.test(item.fileName)) continue;
                    const hash = crypto.createHash('sha1').update(item.source).digest('hex');
                    emitted.set(hash, (emitted.get(hash) ?? new Set()).add(item.fileName));
                  }
                },
              },
            ],
          },
        });
      },
      'astro:routes:resolved': ({ routes: resolved }) => {
        routes = resolved.filter((r) => r.type === 'page' && r.origin === 'project');
      },
      'astro:build:done': async ({ dir, logger }) => {
        const distDir = fileURLToPath(dir);
        const settings = readConfig(root);
        const production = process.env.PUBLIC_SITE_ENV === 'production';
        const t0 = Date.now();

        let pages = scanPages(distDir, site, { production });
        const filled = fillHtmlSitemaps({ pages, locales, settings, log: (m) => logger.warn(m) });
        logger.info(`HTML sitemaps: ${Object.entries(filled).map(([p, n]) => `${p} ${n} links`).join(', ') || 'none'}`);

        const up = await copyOldImages({ root, distDir, emitted });
        logger.info(
          `Old image addresses: ${up.originals} originals (${up.converted} converted to the old format) + ${up.variants.length} size variants copied to /wp-content/uploads/ ` +
            `(${(up.bytes / 1048576).toFixed(1)} MB) from ${up.matched} of ${up.used} images in use` +
            `${up.exactMatch ? '' : ' (matched by file name: the build gave no emitted-image data)'}; ` +
            `${up.unmatched.length} without a known old address, ${up.ambiguous.length} ambiguous.`,
        );

        const lastmod = lastmodResolver({ root, routes: routes.map((r) => ({ entrypoint: r.entrypoint, patternRegex: r.patternRegex })), editsAfter: options.editsAfter ?? null, log: (m) => logger.info(m) });
        const xml = buildXmlSitemaps({ pages, distDir, site, lastmod, locales, settings });
        logger.info(`XML sitemaps: ${Object.entries(xml.counts).map(([f, n]) => `${f} ${n}`).join(', ')}; lastmod from ${JSON.stringify(xml.lastmodFrom)}`);

        const files = new Set(walk(distDir, (rel, e) => e.isDirectory() && rel === '_astro').filter((f) => !f.endsWith('index.html')).map((f) => decodePath('/' + f)));
        const red = buildRedirects({ root, distDir, pages: new Set(pages.map((p) => p.path)), files, locales, settings });
        logger.info(`Redirects: ${red.ruleLines} rules for ${red.rules.length} URLs (${Object.entries(red.counts).map(([g, n]) => `${g} ${n}`).join(', ')})`);
        // A paginated URL that a hand-made list already redirects is expected; anything else dropped is worth a line.
        for (const d of red.dropped.filter((x) => x.group !== 'pagination' || x.reason.startsWith('source is'))) logger.info(`  dropped ${d.from} → ${d.to} (${d.group}): ${d.reason}`);
        for (const p of red.problems) logger.warn(`  ${p.from}: ${p.reason}`);

        const check = checkDist({ distDir, site, production, pages });
        const s = check.stats;
        logger.info(`dist/: ${s.files} files, ${(s.bytes / 1048576).toFixed(0)} MB, largest ${s.largest.file} ${(s.largest.bytes / 1048576).toFixed(1)} MB (limits: 20,000 files, 25 MiB per file)`);
        for (const w of check.warnings) logger.warn(w);
        if (check.errors.length) {
          logger.warn(`${check.errors.length} problems (npm run check:dist lists them all):`);
          for (const e of check.errors.slice(0, 25)) logger.warn(`  ${e}`);
        }
        logger.info(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
      },
    },
  };
}
