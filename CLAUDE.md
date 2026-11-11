# CLAUDE.md

## SEO
This site follows the SEO playbook in `docs/seo/` (a git submodule; the guides are in `docs/seo/astro-seo-playbook/`).
Before building or changing pages, layouts, routing, content collections,
redirects or deployment config, read `docs/seo/astro-seo-playbook/00-claude-instructions.md`
and the files it points to. Site-specific SEO values live in `src/config/site.ts`.
Site-specific overrides to the playbook are listed below this line:
- **This repo is the iPlan Wellness site, built before the template and merged into it (2026-11-11).** It is an Astro 5 site, Thai only (no `/en/` pages yet); the template's own `src/` (Base layout, `src/config/*`, English pages) was replaced by the site's. Where the notes further down describe the template, the iPlan specifics below win.
- Site settings live in `src/consts.ts` (not `src/config/site.ts`). `SITE.url` there reads the `const SITE = '…';` line of `astro.config.mjs`.
- Indexing: `LAUNCHED` in `src/consts.ts` is true only for a production build (Workers Builds of `main`) whose `SITE` is the real domain, so the site becomes indexable automatically after "Go live" rewrites `SITE`. Every other build is `noindex` with robots.txt `Disallow: /`; `PUBLIC_NOINDEX=true` forces noindex.
- It has a Worker script: the `@astrojs/cloudflare` adapter, for the contact form endpoint `src/pages/api/contact.ts` (Turnstile + e-mail). All pages are still prerendered static assets. Secrets on the Worker: `TURNSTILE_SECRET_KEY` (or `TURNSTILE_SECRET`); optional `send_email` binding `EMAIL`, `FORM_TO`, `FORM_FROM`.
- Redirects, XML sitemap and HTML sitemap come from the site itself (`public/_redirects`, `@astrojs/sitemap` → `/sitemap-index.xml`, `src/pages/sitemap.astro`). The template's `integrations/site-files/`, `inventory/` and `scripts/check-dist.mjs` / `seo-parity.py` are kept for the migration checks but are not wired into the build yet.
- Images: WebP only, registered with alt text in `src/data/images.json`; `npm run audit` checks every built page (alt, WebP, title, description, canonical, one h1).
- Languages: Thai is the default language at `/`, English is under `/en/` (the playbook's examples use English as the default).
- The canonical origin is the `const SITE = '…';` line in `astro.config.mjs`. `SITE.url` in `src/config/site.ts` reads it from Astro (`import.meta.env.SITE`); never hardcode it.
- `wrangler.jsonc` has `workers_dev: true` and no `routes` (playbook 08 says `workers_dev: false` plus a route). The workers.dev address is kept out of search by a header instead; see "Deployment" below.
- The checker from playbook 10 is `scripts/seo-check.mjs`, run as `npm run check:dist`.

## WordPress migration

This site replaces a WordPress site. The process is `docs/MIGRATION.md` (playbook guides 11 and 12). Per-site settings of the tools are in `migration.config.json`; the tools are `inventory/crawl.py`, `integrations/site-files/` (runs during every build: `_redirects`, `sitemap_index.xml` and child sitemaps, HTML sitemaps, old image addresses), `scripts/check-dist.mjs` and `scripts/seo-parity.py`. Never drop an old URL that returned 200 without a page or a redirect.

## How this repo is built and deployed

- Astro 7, static output (`dist/`), served by **Cloudflare Workers static assets** (no Worker script). `wrangler.jsonc` holds the Worker.
- **Cloudflare Workers Builds** deploys it: `npm run build`, then `npx wrangler deploy`. The build needs no secrets or env vars.
- A build of `main` is production (Workers Builds sets `WORKERS_CI_BRANCH`); any other build, including a local `npm run build`, is a preview: every page `noindex` and robots.txt `Disallow: /`. Build as production locally with `SITE_ENV=production npm run build`.
- Before deploying: `npm run check` (astro check) and `SITE_ENV=production npm run build && npm run check:dist` (the integration's checks plus the playbook 10 checker).
- **Provisioner contract — don't change the form of these lines.** A provisioner creates new sites from this template and rewrites them with a regex:
  - `wrangler.jsonc`: the single line `"name": "<worker-name>",` (the Worker's name).
  - `astro.config.mjs`: the single line `const SITE = 'https://…';` (first the site's workers.dev address, later its real domain).
  Keep each on one line and exactly one of each. "Go live" in Foxworks attaches the domain and then writes a `"routes": [...]` line (custom domains) right after the name line and the domain as `SITE`; keep that line as it is.
- **workers.dev is never indexed.** `public/_headers` has a rule `https://:worker.:subdomain.workers.dev/*` → `X-Robots-Tag: noindex`. Workers static assets `_headers` rules can match absolute URLs with placeholders, and a placeholder matches one hostname label, so the rule covers `<worker>.<subdomain>.workers.dev` and preview URLs (`<version>-<worker>.<subdomain>.workers.dev`) but never the real domain. No Worker script or `run_worker_first` is needed. (Cloudflare docs: developers.cloudflare.com/workers/static-assets/headers/.) `_redirects` responses don't get `_headers` headers; they carry no content.
- Pages: `src/pages/` (Thai) and `src/pages/en/` (English). Every page passes its key in `src/config/routes.ts` to `Base` (`routeKey`) for hreflang and the language switcher, and its names in `src/config/nav.ts`.
- Playbook updates: `git submodule update --remote docs/seo`, then commit.
