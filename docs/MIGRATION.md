# Moving a WordPress site to this repo

The process is playbook guide 11 (`docs/seo/astro-seo-playbook/11-wordpress-migration.md`), and guide 12 maps every Rank Math/Yoast feature to where it lives here. This page only says which tool in this repo does which step.

## 1. Settings: `migration.config.json`

One file for every per-site setting the tools read:

| Key | What it is |
| --- | --- |
| `oldSite.origin`, `oldSite.hosts` | The old WordPress address and the hostnames it answers on |
| `oldSite.languages` | Default language (no prefix), prefixed languages, `og:locale` per language |
| `oldSite.siteNames` | Brand names the old titles end with, e.g. "Example Co." |
| `oldSite.theme` | CSS classes of the old theme's content and sidebar (empty: `<main>` is the content) |
| `oldSite.postTypes`, `oldSite.taxonomies` | Custom post types and taxonomies, with their URL prefixes |
| `inputs` | Where the WordPress export, Search Console exports and a redirects list are |
| `htmlSitemap`, `xmlSitemaps`, `videoSitemapPaths` | How the HTML and XML sitemaps are grouped, named and labelled |
| `redirects` | Old sitemap addresses to point at the new index, and prefixes with no short URLs |
| `parity` | Changes decided for this site (path regexes), reported as "expected" by the parity check |

## 2. Inventory the old site (guide 11, steps 1–2)

Put the inputs in `inventory/input/` (see `inventory/README.md`), then:

```sh
python3 inventory/crawl.py                    # read-only crawl, resumes from its cache
python3 inventory/crawl.py --offline          # rebuild the outputs from the cache
```

It writes `inventory/urls.json`, `redirects.csv`, `images.csv`, `vimeo.csv`, `search-console.csv` and `REPORT.md`. Read REPORT.md first.

## 3. Build the pages

Every old URL that returned 200 needs a page at the same path, or a redirect. Titles, descriptions, canonicals and hreflang follow guide 12.

## 4. Redirects, sitemaps, old image addresses: automatic on every build

`integrations/site-files/` runs during `npm run build` and writes:
- `dist/_redirects` from `inventory/redirects.csv`, `inventory/redirects-todo/*.csv` and the crawl
- `sitemap_index.xml` and the child sitemaps named in the config
- the HTML sitemaps
- the old `/wp-content/uploads/` addresses of images that moved

A missing inventory file is skipped, so the template builds with an empty `inventory/`.

## 5. Check before the switch (guide 11, step 6)

```sh
SITE_ENV=production npm run build && npm run check:dist    # the build's own checks plus the playbook 10 checker
SITE_ENV=production npx astro build --outDir /tmp/dist-prod
python3 scripts/seo-parity.py /tmp/dist-prod               # every live old URL against the new build
```

## 6. Switch

In Foxworks: the site's page, **Connect domain**, then **Go live** once the client has approved the new site. Then follow guide 11's after-launch steps (Search Console, the old sitemap, 404 monitoring).
