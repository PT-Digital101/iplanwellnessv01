import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';

const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		/** URL slug – must match the live WordPress post_name */
		slug: z.string(),
		/** Primary category slug – first URL segment (/%category%/%postname%/) */
		categorySlug: z.string(),
		/** Rank Math focus keyword */
		focusKeyword: z.string().optional(),
		/** Original WordPress post ID (for reference) */
		wpId: z.number().optional(),
		/** Meta description (≈ 150–160 chars). Also used as the card excerpt. */
		description: z.string(),
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		category: z.string().default('Wellness'),
		tags: z.array(z.string()).default([]),
		/** Path inside src/assets/images – must be .webp */
		heroImage: z.string().regex(/\.webp$/, 'heroImage must be a .webp file'),
		/** Required alt text for the hero image */
		heroAlt: z.string().min(1),
		featured: z.boolean().default(false),
		/** Optional SEO overrides (from All in One SEO) */
		seoTitle: z.string().optional(),
		canonical: z.string().url().optional(),
		noindex: z.boolean().default(false),
	}),
});

export const collections = { blog };
