# inventory/

What the old WordPress site has, so nothing gets lost in the move (`docs/MIGRATION.md`, playbook guide 11).

## Inputs: `inventory/input/` (all optional; a missing one is skipped)

- `wordpress-export.xml`: Tools → Export → All content in WordPress (not committed: `.gitignore`)
- `search-console/`: the Pages and Queries CSV exports from Google Search Console (last 16 months)
- `redirects.md`: redirects the old site had (from the Redirection or Rank Math plugin), one `from → to` per line

The paths are set in `migration.config.json` (`inputs`).

## Run

```sh
python3 inventory/crawl.py                    # crawl (resumes from inventory/.cache/)
python3 inventory/crawl.py --offline          # outputs from the cache only
python3 inventory/crawl.py --max-requests 300
```

## Outputs (committed: the build reads them)

- `urls.json`: every URL found, with status, redirects, title, canonical, hreflang and more
- `redirects.csv`: redirects the old site already does
- `images.csv`: images and where the pages use them
- `vimeo.csv`, `search-console.csv`, `REPORT.md`

## Files you add by hand

- `redirects-todo/*.csv`: redirects to add, columns `from,to,note` (`lost-urls.csv` is read first)
- `wp-modified.csv`: `path,modified` (ISO date) per page, for `<lastmod>` in the sitemaps. Without it the build uses the files' git dates.
