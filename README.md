# iPlan Wellness — website (V3 design)

Astro static site deployed to Cloudflare Workers. Built from the **V3 (Treza-style)** pages in the iPlan Wellness design canvas; brand tokens come from the canvas's *Brand Identity* board.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Build to `dist/` (all images → responsive WebP) |
| `npm run audit` | After a build: fails if any `<img>` lacks alt or isn't WebP, or a page lacks title / description / canonical / single `<h1>` |
| `npm run check` | Type-check + build + audit + Wrangler dry run |
| `npm run images -- <file> --to <folder/name.webp>` | Convert a real photo to optimised WebP with an SEO file name |
| `npm run images:placeholders` | Create on-brand placeholders for any registered image that is missing (never overwrites) |
| `npm run deploy` | Deploy to Cloudflare |

## Where things live

| What | File |
| --- | --- |
| Brand colors, type, components | `src/styles/global.css` (tokens on `:root`) |
| Site name, contact details, **URL paths**, form endpoints, video links | `src/consts.ts` |
| Services list + names (menu, footer, cards) | `src/data/services.ts` |
| Service page copy (hero, suitable-for, process, why-us) | `src/data/service-pages.json` |
| Home/About copy (clients, industries, process, FAQ) | `src/data/home.ts` |
| Privacy / Terms copy | `src/data/legal.json` |
| **Image registry (file name + alt text)** | `src/data/images.json` |
| Blog posts | `src/content/blog/*.md` (frontmatter: `heroImage` .webp + `heroAlt` required) |

## Images & SEO rules

- Every image file is `.webp` in `src/assets/images/<section>/<descriptive-kebab-name>.webp`.
- Every image is rendered through `<Img>` which **requires alt text** and outputs responsive WebP with width/height (no layout shift). The build throws if alt or file is missing.
- Swap a placeholder for a real photo: `npm run images -- ~/Downloads/photo.jpg --to home/healthcare-wellness-digital-marketing-agency-hero.webp`, then refine the alt in `src/data/images.json`.
- Per page: unique title + meta description, canonical, Open Graph/Twitter, JSON-LD (ProfessionalService, WebSite, BreadcrumbList, Service, FAQPage, Blog/BlogPosting), sitemap (`/sitemap-index.xml`), `robots.txt`, RSS (`/rss.xml`).
- **URLs are identical to the live WordPress site** (verified against its Rank Math sitemaps: all 107 URLs present). Services live at `/<service>/`, posts at `/<category>/<post>/`, archives at `/category/<slug>/`. Paths are in `PATHS` in `src/consts.ts`; WordPress-only endpoints (feeds, old sitemaps, `/blog/page/N/`) 301 via `public/_redirects`.
- Human-readable sitemap at `/sitemap/` (footer link); XML at `/sitemap-index.xml`.

## Content source

The 83 blog posts in `src/content/blog/` were imported from the WordPress backup (All-in-One WP Migration, Nov 2026): body, dates, categories, tags, featured + inline images (converted to WebP), and Rank Math SEO title / description / focus keyword. Posts without a Rank Math description got one generated from the excerpt/opening paragraph. `wpId` in frontmatter is the original post ID.

## Still to do (needs client input)

- Real photography for page heroes/sections (placeholders are marked `[ LABEL ]`; blog images are real).
- Contact form endpoint (`SITE.contactFormAction`). Until set, submitting opens the visitor's e-mail app pre-filled to hello@iplandigital.com.
- Brand film / showreel URLs (`SITE.brandFilmUrl`, `SITE.showreelUrl`) — play buttons appear once set.
