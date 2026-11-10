// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
	site: 'https://iplanwellness.com',
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
	adapter: cloudflare({
		imageService: 'compile',
		platformProxy: { enabled: true },
	}),
});
