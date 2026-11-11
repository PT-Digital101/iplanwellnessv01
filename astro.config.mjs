// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

// Canonical origin, no trailing slash. Canonicals, JSON-LD, the sitemap and robots.txt all come from it
// (src/consts.ts reads it as import.meta.env.SITE).
// The Foxworks provisioner rewrites this line: first the site's workers.dev address, later its real domain.
const SITE = 'https://iplan-wellness.iplandigital.workers.dev';

// Production = a Workers Builds build of main (or SITE_ENV=production locally). Every other build is a preview.
// Pages are only indexable when this is production AND SITE is the real domain (see LAUNCHED in src/consts.ts).
const branch = process.env.WORKERS_CI_BRANCH ?? 'local'; // injected by Cloudflare Workers Builds
const isProd = process.env.SITE_ENV === 'production' || branch === 'main';
process.env.PUBLIC_SITE_ENV = isProd ? 'production' : 'preview';

// https://astro.build/config
export default defineConfig({
	site: SITE,
	// Match WordPress permalinks (/page-name/) so existing URLs keep their rankings.
	trailingSlash: 'always',
	build: { format: 'directory' },
	integrations: [
		mdx(),
		sitemap({
			filter: (page) => !page.includes('/404'),
			i18n: { defaultLocale: 'th', locales: { th: 'th-TH' } },
		}),
	],
	image: {
		// Images are optimised to WebP at build time with sharp.
		responsiveStyles: false,
	},
	vite: {
		define: { 'import.meta.env.PUBLIC_SITE_ENV': JSON.stringify(process.env.PUBLIC_SITE_ENV) },
	},
	adapter: cloudflare({
		imageService: 'compile',
		platformProxy: { enabled: true },
	}),
});
