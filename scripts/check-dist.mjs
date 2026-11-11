// Checks the built site in dist/ (run after `npm run build`): redirects, XML sitemaps, Cloudflare's static asset
// limits. Prints the counts and every problem; exits with 1 when there is a problem.
//
//   npm run check:dist
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDist } from '../integrations/site-files/checks.mjs';
import astroConfig from '../astro.config.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, 'dist');
const site = String(astroConfig.site).replace(/\/$/, ''); // the SITE line in astro.config.mjs
const { errors, warnings, stats } = checkDist({ distDir, site, production: process.env.PUBLIC_SITE_ENV === 'production' });

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
console.log(`dist/: ${stats.pages} pages, ${stats.files} files (limit 20,000), ${mb(stats.bytes)}; largest file ${stats.largest.file} ${mb(stats.largest.bytes)} (limit 25 MiB)`);
console.log(`Old image addresses: ${stats.uploads} files under /wp-content/uploads/`);
console.log(`Redirects: ${stats.redirectRules} static rules (limit 2,000), ${stats.redirectTargetsMissing} targets not built`);
for (const [g, n] of Object.entries(stats.redirectGroups ?? {})) console.log(`  ${g.padEnd(14)} ${String(n.urls).padStart(4)} URLs  ${String(n.rules).padStart(4)} rules`);
console.log(`XML sitemaps: ${stats.sitemapUrls} URLs`);
for (const [f, n] of Object.entries(stats.sitemaps ?? {})) console.log(`  ${f.padEnd(28)} ${String(n.urls).padStart(4)} URLs, ${n.images} images, ${n.videos} videos, ${n.alternates} hreflang links`);
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
console.log(errors.length ? `${errors.length} errors.` : 'No errors.');
process.exit(errors.length ? 1 : 0);
