#!/usr/bin/env python3
"""SEO parity check (playbook 11, section 6): every live URL in inventory/urls.json against a production build.

For each live HTML page that returned 200 it checks that the new site has the page (or redirects it), and compares
the title, meta description, canonical, robots, hreflang set, <html lang>, H1, og:locale/og:type/og:title/
og:description/og:url/og:image and twitter:card. Values are compared after HTML unescaping and whitespace
normalisation. Changes decided for this site (parity in migration.config.json, path regular expressions) are
reported separately as "expected", not as errors.

URLs are compared by path: the build's own origin (the SITE line in astro.config.mjs, e.g. the workers.dev address
before the switch) is read as the old site's origin (oldSite.origin in migration.config.json).

Usage (from the repo root, after a production build):
    SITE_ENV=production npx astro build --outDir /tmp/dist-prod
    python3 scripts/seo-parity.py /tmp/dist-prod [--all]     # --all lists every mismatch instead of 8 per check
"""
import html, json, os, re, sys, urllib.parse
from collections import defaultdict
from html.parser import HTMLParser

DIST = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'dist'
SHOW_ALL = '--all' in sys.argv
CONFIG = json.load(open('migration.config.json', encoding='utf-8'))
ORIGIN = CONFIG['oldSite']['origin'].rstrip('/')
OG_LOCALES = CONFIG['oldSite']['languages'].get('ogLocales') or {}
PARITY = CONFIG.get('parity') or {}


def matches(key, path):
    """True when path matches one of the regular expressions in parity.<key> (a decided change)."""
    return any(re.search(rx, path) for rx in PARITY.get(key) or [])


def old_origin(u):
    """The URL with the new build's origin replaced by the old site's, so paths are compared."""
    return re.sub(r'^https?://[^/]+', ORIGIN, u or '')


def norm(s):
    return re.sub(r'\s+', ' ', html.unescape(s or '').replace(' ', ' ')).strip()


def canon_url(u):
    """Lowercase percent-encoding, as WordPress and urls.json write it."""
    return re.sub(r'%[0-9A-Fa-f]{2}', lambda m: m.group(0).lower(), old_origin(u))


class Head(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.links, self.h1, self.lang = {}, [], [], None
        self.title, self._in_title, self._h1_depth, self._h1_buf = '', False, 0, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'html':
            self.lang = a.get('lang')
        elif tag == 'title':
            self._in_title = True
        elif tag == 'meta':
            key = a.get('name') or a.get('property')
            if key and key not in self.meta:
                self.meta[key] = a.get('content', '')
        elif tag == 'link':
            self.links.append(a)
        elif tag == 'h1':
            self._h1_depth += 1
            self._h1_buf = []
        if self._h1_depth and tag in ('br',):
            self._h1_buf.append(' ')

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False
        elif tag == 'h1' and self._h1_depth:
            self._h1_depth -= 1
            self.h1.append(norm(''.join(self._h1_buf)))

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._h1_depth:
            self._h1_buf.append(data)


def built_file(path):
    p = urllib.parse.unquote(path).strip('/')
    return os.path.join(DIST, p, 'index.html') if p else os.path.join(DIST, 'index.html')


def load_redirects():
    out = {}
    f = os.path.join(DIST, '_redirects')
    if os.path.exists(f):
        for line in open(f, encoding='utf-8'):
            parts = line.split()
            if len(parts) >= 2 and not line.startswith('#'):
                out[urllib.parse.unquote(parts[0])] = parts[1]
    return out


inventory = json.load(open('inventory/urls.json', encoding='utf-8'))['urls']
redirects = load_redirects()
live = [u for u in inventory if u['status'] == 200 and (u.get('content_type') or '').startswith('text/html')]

issues = defaultdict(list)    # check -> [(path, live, new)]
expected = defaultdict(list)  # decided changes
counts = defaultdict(int)

BLOG_TYPES = {'post'}

for u in live:
    path = urllib.parse.unquote(urllib.parse.urlparse(u['url']).path)
    f = built_file(path)
    if not os.path.exists(f):
        if path in redirects or path.rstrip('/') in redirects:
            counts['redirected'] += 1
        else:
            issues['missing page'].append((path, u['type'], ''))
        continue
    counts['compared'] += 1
    p = Head()
    p.feed(open(f, encoding='utf-8').read())
    m = p.meta

    def cmp(check, old, new, expect=None):
        if norm(old) != norm(new):
            (expected if expect else issues)[check].append((path, norm(old)[:110], norm(new)[:110]))

    rewritten = matches('expectedTitleChange', path)  # decided: new title and description (e.g. translated at last)
    cmp('title' + (' (decided change)' if rewritten else ''), u.get('title'), p.title, expect=rewritten)
    if u.get('meta_description'):
        cmp('description' + (' (decided change)' if rewritten else ''), u['meta_description'], m.get('description'), expect=rewritten)
    elif not m.get('description'):
        issues['description missing (live had none either)'].append((path, '', ''))

    canon = next((l.get('href') for l in p.links if l.get('rel') == 'canonical'), '')
    if canon_url(canon) != canon_url(u['url']):
        (expected if not u.get('canonical_is_self') else issues)['canonical'].append((path, u.get('canonical'), canon))

    robots = m.get('robots', '')
    if u.get('noindex'):
        if 'noindex' not in robots:
            issues['robots: live noindex, new indexable'].append((path, u.get('robots'), robots))
        elif 'nofollow' in robots:
            issues['robots: noindex should be "noindex, follow"'].append((path, u.get('robots'), robots))
    elif 'noindex' in robots:
        issues['robots: live indexable, new noindex'].append((path, u.get('robots'), robots))

    live_hl = {k: canon_url(v) for k, v in (u.get('hreflang') or {}).items()}
    new_hl = {l.get('hreflang'): canon_url(l.get('href')) for l in p.links if l.get('rel') == 'alternate' and l.get('hreflang')}
    if live_hl != new_hl:
        decided = matches('expectedHreflangChange', path) or (not live_hl and new_hl)
        (expected if decided else issues)['hreflang'].append((path, json.dumps(live_hl, ensure_ascii=False)[:110], json.dumps(new_hl, ensure_ascii=False)[:110]))

    want_lang = u['lang']
    if (p.lang or '').split('-')[0] != want_lang:
        issues['html lang'].append((path, want_lang, p.lang))

    live_h1 = [norm(h) for h in (u.get('h1') or []) if norm(h)]
    if live_h1 and p.h1 and norm(p.h1[0]).lower() != norm(live_h1[0]).lower() and norm(p.h1[0]).lower().startswith(norm(live_h1[0]).lower()):
        issues['h1 starts with the live H1 but adds the hero sub-line'].append((path, live_h1[0][:110], p.h1[0][:110]))
    elif live_h1 and (not p.h1 or norm(live_h1[0]).lower() != norm(p.h1[0]).lower()):
        if norm(live_h1[0]) == 'Archive' or matches('expectedH1Change', path):
            expected['h1 (live "Archive" or decided change)'].append((path, live_h1[0][:110], (p.h1 or [''])[0][:110]))
        elif u['type'] in BLOG_TYPES:
            expected['h1 (posts: post title becomes the H1)'].append((path, live_h1[0][:110], (p.h1 or [''])[0][:110]))
        else:
            issues['h1'].append((path, ' | '.join(live_h1)[:110], ' | '.join(p.h1)[:110]))
    if len(p.h1) != 1:
        issues['h1 count != 1'].append((path, len(live_h1), len(p.h1)))

    og = u.get('og') or {}
    first = lambda k: (og.get(k) or [''])[-1]  # Rank Math's value is printed last (the theme's set comes first)
    want_locale = OG_LOCALES.get(u['lang'])
    if want_locale and m.get('og:locale') != want_locale:
        issues['og:locale'].append((path, want_locale, m.get('og:locale')))
    if first('og:type') and m.get('og:type') != first('og:type'):
        # Matching the plugin's og:type is not required (playbook 11, section 4).
        expected['og:type'].append((path, first('og:type'), m.get('og:type')))
    cmp('og:title = title', p.title, m.get('og:title'))
    if m.get('description'):
        cmp('og:description = description', m.get('description'), m.get('og:description'))
    if canon_url(m.get('og:url')) != canon_url(canon):
        issues['og:url = canonical'].append((path, canon, m.get('og:url')))
    if not m.get('og:image'):
        (issues if first('og:image') else expected)['og:image missing' + ('' if first('og:image') else ' (live had none; default image to come)')].append((path, first('og:image')[-60:], ''))
    for k in ('og:image:width', 'og:image:height'):
        if m.get('og:image') and not m.get(k):
            issues[f'{k} missing (playbook 02)'].append((path, '', ''))
    if m.get('twitter:card') != 'summary_large_image':
        issues['twitter:card'].append((path, 'summary_large_image', m.get('twitter:card')))

# New pages that the live site doesn't have
live_paths = {urllib.parse.unquote(urllib.parse.urlparse(u['url']).path) for u in inventory}
new_pages = []
for root, _, files in os.walk(DIST):
    if 'index.html' in files:
        rel = '/' + os.path.relpath(root, DIST).strip('.').strip('/') + '/'
        rel = rel.replace('//', '/')
        if rel not in live_paths and not rel.startswith('/wp-content/'):
            new_pages.append(rel)

print(f"Live HTML pages: {len(live)}; compared {counts['compared']}; redirected {counts['redirected']}; new pages not on the live site: {len(new_pages)}\n")
print('ISSUES')
for check, rows in sorted(issues.items(), key=lambda kv: -len(kv[1])):
    print(f'  {len(rows):4d}  {check}')
    for r in rows if SHOW_ALL else rows[:8]:
        print(f'          {r[0]}\n            live: {r[1]}\n            new:  {r[2]}')
print('\nEXPECTED (decided changes)')
for check, rows in sorted(expected.items(), key=lambda kv: -len(kv[1])):
    print(f'  {len(rows):4d}  {check}')
print('\nNEW PAGES')
print('  ' + ', '.join(sorted(new_pages)[:60]) + (' …' if len(new_pages) > 60 else ''))
