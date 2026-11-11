#!/usr/bin/env python3
"""
URL inventory crawler for the old WordPress site (read-only). Settings: oldSite and inputs in
migration.config.json (the old site's address, languages, theme, custom post types, input files).

Usage (from the repo root):

    python3 inventory/crawl.py                 # crawl (resumes from the cache) and write all outputs
    python3 inventory/crawl.py --offline       # rebuild the outputs from the cache only, no network
    python3 inventory/crawl.py --max-requests 300   # stop after 300 network requests, outputs still written

Politeness rules:
- GET requests only, a normal browser User-Agent, at most one request per --delay seconds (default 1.1).
- One retry on network errors, 5xx and 429.
- No form submissions, no external hosts, no query-string URLs, feeds, /wp-json/, /wp-admin/,
  /wp-content/ or /cdn-cgi/ pages. Elementor's per-page CSS files under
  /wp-content/uploads/elementor/css/ are the one exception: they are read once each to find the
  background images that pages use.
- Redirects are never followed automatically: each hop is recorded (status, Location), then the
  target is queued and fetched once like any other URL.

Seeds: robots.txt -> sitemap index -> all child sitemaps (incl. a video sitemap), every URL in the
Search Console exports, the WordPress export (published items, _wp_old_slug URLs, term, date and
author archives, a small attachment-page sample) and redirects.md. Internal links from every 200 HTML
page are then followed. Each input is optional: a missing file is skipped (see inventory/README.md).

Raw responses are cached gzip-compressed under inventory/.cache/http/ (parse results under
inventory/.cache/parsed/). Delete a cache file to refetch that URL.

Outputs in inventory/: urls.json, redirects.csv, vimeo.csv, images.csv, search-console.csv, REPORT.md
"""

import argparse
import collections
import csv
import difflib
import gzip
import hashlib
import html
import http.client
import json
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
CACHE = HERE / '.cache'
HTTP_CACHE = CACHE / 'http'
PARSE_CACHE = CACHE / 'parsed'
CONFIG = json.loads((REPO / 'migration.config.json').read_text('utf-8'))
OLD = CONFIG['oldSite']
EXPORT = REPO / CONFIG['inputs']['wordpressExport']
SC_DIR = REPO / CONFIG['inputs']['searchConsole']
REDIRECTS_MD = REPO / CONFIG['inputs']['redirectsMd']

ORIGIN = OLD['origin'].rstrip('/')
HOST = urllib.parse.urlsplit(ORIGIN).hostname
HOSTS = {HOST, *OLD['hosts']}
# Languages of the old site: the default one at the root, the others under /<code>/.
LANG_DEFAULT = OLD['languages']['default']
LANGS = [LANG_DEFAULT] + [l for l in OLD['languages']['prefixed'] if l != LANG_DEFAULT]
# Theme markup: the element class of the main content and of the sidebar. Without contentClass, <main> is the content.
CONTENT_CLASS = OLD['theme'].get('contentClass') or ''
SIDEBAR_CLASS = OLD['theme'].get('sidebarClass') or ''
# Custom post types: {wp post_type: {"type": inventory type, "path": regex of its single URLs without the language prefix}}
POST_TYPES = OLD.get('postTypes') or {}
SITE_NAMES = OLD.get('siteNames') or []
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36')
PARSER_VERSION = 3
MAX_URLS = 6000

# --------------------------------------------------------------------------------------------
# URL helpers
# --------------------------------------------------------------------------------------------

SAFE = "/:@!$&'()*+,;=-._~"
SKIP_PREFIXES = ('/wp-json', '/wp-admin', '/wp-content', '/wp-includes', '/cdn-cgi', '/xmlrpc.php',
                 '/wp-login.php', '/wp-cron.php', '/wp-signup.php', '/wp-activate.php', '/wp-comments-post.php')
ASSET_EXT = re.compile(r'\.(jpe?g|png|gif|webp|svg|avif|bmp|ico|tiff?|pdf|zip|rar|7z|mp4|mov|webm|m4v|mp3|wav|'
                       r'docx?|xlsx?|pptx?|css|js|json|txt|woff2?|ttf|eot|otf|xml|xsl|gz|heic|php)$', re.I)


def quote_path(path):
    return urllib.parse.quote(urllib.parse.unquote(path), safe=SAFE)


def decode(url):
    return urllib.parse.unquote(url) if url else url


def normalize(href, base=ORIGIN + '/'):
    """Return (url, reason). reason is None for a crawlable internal HTML URL.

    url is the normalised absolute URL (ORIGIN's host, percent-encoded path, no fragment) for
    internal URLs, also when they are noise (reason says why), and None for external or unusable links.
    """
    if href is None:
        return None, 'empty'
    href = href.strip()
    if not href or href.startswith('#'):
        return None, 'fragment'
    low = href.lower()
    if low.startswith(('mailto:', 'tel:', 'javascript:', 'data:', 'sms:', 'whatsapp:', 'skype:', 'viber:',
                       'line:', 'fb-messenger:', 'intent:')):
        return None, 'scheme'
    try:
        p = urllib.parse.urlsplit(urllib.parse.urljoin(base, href))
        host = (p.hostname or '').lower()
    except ValueError:
        return None, 'invalid'
    if p.scheme not in ('http', 'https'):
        return None, 'scheme'
    if host not in HOSTS:
        return None, 'external'
    path = quote_path(p.path or '/')
    url = ORIGIN + path
    lp = urllib.parse.unquote(path).lower()
    if p.query:
        return url + '?' + p.query, 'query'
    if lp.startswith(SKIP_PREFIXES):
        return url, 'skip-path'
    if re.search(r'/(feed|rss2?|atom|rdf)/?$', lp) or '/feed/' in lp:
        return url, 'feed'
    if re.search(r'/(embed|trackback)/?$', lp):
        return url, 'embed'
    if ASSET_EXT.search(lp):
        return url, 'asset'
    return url, None


def upload_url(raw, base=ORIGIN + '/'):
    """Normalise a /wp-content/uploads/ reference to an absolute https://www. URL without query."""
    raw = raw.replace('\\/', '/').strip()
    try:
        p = urllib.parse.urlsplit(urllib.parse.urljoin(base, raw))
    except ValueError:
        return None
    if (p.hostname or HOST).lower() not in HOSTS:
        return None
    if '/wp-content/uploads/' not in p.path:
        return None
    return ORIGIN + quote_path(p.path)


# --------------------------------------------------------------------------------------------
# HTTP fetching with cache
# --------------------------------------------------------------------------------------------

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)
DROP_HEADERS = {'set-cookie', 'report-to', 'nel', 'alt-svc', 'cf-ray', 'date'}


class Fetcher:
    def __init__(self, offline=False, max_requests=None, delay=1.1, verbose=True):
        self.offline = offline
        self.max_requests = max_requests
        self.delay = delay
        self.verbose = verbose
        self.requests = 0
        self.last = 0.0
        self.mem = {}

    @staticmethod
    def key(url):
        return hashlib.sha1(url.encode('utf-8')).hexdigest()

    def paths(self, url):
        k = self.key(url)
        d = HTTP_CACHE / k[:2]
        return d / (k + '.json'), d / (k + '.body.gz')

    def cached(self, url):
        if url in self.mem:
            return self.mem[url]
        mp, _ = self.paths(url)
        if mp.exists():
            meta = json.loads(mp.read_text('utf-8'))
            self.mem[url] = meta
            return meta
        return None

    def body(self, url):
        _, bp = self.paths(url)
        if not bp.exists():
            return b''
        return gzip.decompress(bp.read_bytes())

    def text(self, url):
        meta = self.cached(url)
        raw = self.body(url)
        charset = 'utf-8'
        ct = (meta or {}).get('content_type') or ''
        m = re.search(r'charset=([\w-]+)', ct, re.I)
        if m:
            charset = m.group(1)
        try:
            return raw.decode(charset, errors='replace')
        except LookupError:
            return raw.decode('utf-8', errors='replace')

    def budget_left(self):
        return not self.offline and (self.max_requests is None or self.requests < self.max_requests)

    def get(self, url):
        meta = self.cached(url)
        if meta is not None:
            return meta
        if not self.budget_left():
            return None
        meta, body = self._fetch(url)
        mp, bp = self.paths(url)
        mp.parent.mkdir(parents=True, exist_ok=True)
        bp.write_bytes(gzip.compress(body or b''))
        mp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), 'utf-8')
        self.mem[url] = meta
        return meta

    def _fetch(self, url):
        body = b''
        meta = {}
        for attempt in (1, 2):
            wait = self.delay - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            self.requests += 1
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip',
            })
            status, headers, error = None, None, None
            t0 = time.time()
            try:
                resp = OPENER.open(req, timeout=40)
                status, headers, body = resp.status, resp.headers, resp.read()
            except urllib.error.HTTPError as e:
                status, headers = e.code, e.headers
                try:
                    body = e.read()
                except Exception:  # noqa: BLE001
                    body = b''
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                    http.client.HTTPException, OSError) as e:
                error = repr(e)
                body = b''
            hdrs = {}
            if headers is not None:
                for k, v in headers.items():
                    k = k.lower()
                    if k in DROP_HEADERS:
                        continue
                    hdrs.setdefault(k, []).append(v)
                if 'gzip' in ','.join(hdrs.get('content-encoding', [])).lower() and body:
                    try:
                        body = gzip.decompress(body)
                    except OSError:
                        pass
            meta = {
                'url': url,
                'status': status,
                'error': error,
                'headers': hdrs,
                'content_type': (hdrs.get('content-type') or [''])[0],
                'location': (hdrs.get('location') or [None])[0],
                'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                'elapsed': round(time.time() - t0, 2),
                'attempts': attempt,
                'bytes': len(body or b''),
            }
            if self.verbose:
                loc = f" -> {meta['location']}" if meta['location'] else ''
                print(f"[{self.requests}] {status or error} {decode(url)}{loc}", file=sys.stderr, flush=True)
            if (status is None or status >= 500 or status == 429) and attempt == 1:
                time.sleep(5)
                continue
            break
        return meta, body


# --------------------------------------------------------------------------------------------
# HTML parsing
# --------------------------------------------------------------------------------------------

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track',
        'wbr', 'keygen', 'command'}
EXCL_TAGS = {'script', 'style', 'noscript', 'template', 'svg', 'select', 'option', 'textarea', 'button', 'iframe',
             'object', 'canvas'}
CHROME_TAGS = {'nav', 'aside', 'header', 'footer', 'form'}
VIMEO_RE = re.compile(r'vimeo\.com/(?:video/|channels/[\w-]+/|groups/[\w-]+/videos/|album/\d+/video/|'
                      r'showcase/\d+/video/|manage/videos/)?(\d{6,12})(?!\d)(?:/([0-9a-f]{6,12})\b|[^"\'\s<>]*?[?&]h=([0-9a-f]{6,12}))?',
                      re.I)
YT_RE = re.compile(r'(?:youtube(?:-nocookie)?\.com/(?:embed/|watch\?(?:[^"\'\s<>]*?&)?v=|v/|shorts/|live/)|'
                   r'youtu\.be/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])', re.I)
UPLOAD_RE = re.compile(r'(?:https?:)?(?://(?:' + '|'.join(re.escape(h) for h in sorted(HOSTS)) + r'))?(/wp-content/uploads/[^\s"\'()<>,\\]+?'
                       r'\.(?:jpe?g|png|gif|webp|svg|avif|bmp|ico|tiff?|pdf|mp4|mov|webm|m4v|mp3|zip|docx?|'
                       r'xlsx?|pptx?|heic))(?=[\s"\'()<>,\\?#&;]|$)', re.I)
IMAGE_EXT = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic'}
MAPS_RE = re.compile(r'(google\.[a-z.]+/maps|maps\.google\.|goo\.gl/maps|maps\.app\.goo\.gl)', re.I)


def ws(s):
    return ' '.join((s or '').split())


class PageParser(HTMLParser):
    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.content_re = re.compile(r'(^|\s)' + re.escape(CONTENT_CLASS) + r'(\s|$)') if CONTENT_CLASS else None
        self.sidebar_re = re.compile(r'(^|\s)' + re.escape(SIDEBAR_CLASS) + r'(\s|$)') if SIDEBAR_CLASS else None
        self.stack = []
        self.cnt = collections.Counter()
        self.in_body = False
        self.lang = None
        self.body_class = ''
        self.title_parts = None
        self.titles = []
        self.metas = []
        self.canonicals = []
        self.hreflang = []
        self.rel_links = []
        self.elementor_css = []
        self.h1 = []
        self.h2 = 0
        self.h2_main = 0
        self.headings = []
        self.cur_heading = None
        self.last_heading = ''
        self.links = []
        self.cur_link = None
        self.content_text = []
        self.body_text = []
        self.has_content = False
        self.rolling = ''
        self.pending = []
        self.videos = []
        self.schema_videos = []
        self.script_videos = []
        self.iframes = []
        self.maps = []
        self.forms = []
        self.search_forms = 0
        self.cur_form = None
        self.label = None
        self.images = collections.OrderedDict()
        self.script_type = ''

    # -- helpers
    def add_image(self, raw, source):
        u = upload_url(raw, self.base)
        if not u:
            return
        self.images.setdefault(u, [])
        if source not in self.images[u]:
            self.images[u].append(source)

    def add_video(self, provider, vid, tag, attr, a, extra=None):
        for v in self._el_videos:
            if v['provider'] == provider and v['id'] == vid:
                return
        occ = {
            'provider': provider, 'id': vid, 'hash': extra,
            'element': tag, 'attr': attr,
            'class': (a.get('class') or '')[:80],
            'title_attr': a.get('title') or a.get('aria-label') or '',
            'heading': self.last_heading,
            'text_before': self.rolling[-160:].strip(),
            'text_after': '',
            'link_text': '',
            'in_main': self.cnt['content'] > 0 and self.cnt['chrome'] == 0,
        }
        self._el_videos.append(occ)
        self.videos.append(occ)
        self.pending.append(occ)
        if tag == 'a' and self.cur_link is not None:
            self.cur_link['videos'].append(occ)

    def scan_videos(self, text, tag, attr, a, sink=None):
        t = text.replace('\\/', '/')
        found = []
        for m in VIMEO_RE.finditer(t):
            found.append(('vimeo', m.group(1), m.group(2) or m.group(3)))
        for m in YT_RE.finditer(t):
            found.append(('youtube', m.group(1), None))
        for prov, vid, extra in found:
            if sink is not None:
                if (prov, vid) not in [(x[0], x[1]) for x in sink]:
                    sink.append((prov, vid))
            else:
                self.add_video(prov, vid, tag, attr, a, extra)

    # -- parser callbacks
    def handle_starttag(self, tag, attrs):
        a = {k: (v if v is not None else '') for k, v in attrs}
        cls = a.get('class', '')
        flags = set()
        self._el_videos = []
        if tag == 'html' and self.lang is None:
            self.lang = a.get('lang')
        elif tag == 'body':
            self.in_body = True
            self.body_class = cls
        if tag in EXCL_TAGS:
            flags.add('excl')
        if tag in CHROME_TAGS or (self.sidebar_re and tag == 'div' and self.sidebar_re.search(cls)):
            flags.add('chrome')
        if (tag == 'div' and self.content_re.search(cls)) if self.content_re else tag == 'main':
            flags.add('content')
            self.has_content = True
        if tag == 'svg':
            flags.add('svg')
        if tag == 'title' and not self.in_body and self.cnt['svg'] == 0:
            self.title_parts = []
            flags.add('title')
        if tag == 'meta':
            self.on_meta(a)
        elif tag == 'link':
            self.on_link(a)
        elif tag == 'a' and self.in_body:
            if self.cur_link is not None:
                self.close_link()
            self.cur_link = {'href': a.get('href'), 'text': [], 'videos': [], 'title': a.get('title', ''),
                             'chrome': self.cnt['chrome'] > 0, 'main': self.cnt['content'] > 0 and self.cnt['chrome'] == 0}
            flags.add('a')
        elif tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6') and self.in_body:
            self.cur_heading = [int(tag[1]), []]
            flags.add('heading')
        elif tag == 'iframe':
            self.on_iframe(a)
        elif tag == 'script':
            self.script_type = (a.get('type') or '').lower()
        elif tag == 'form':
            self.cur_form = {'plugin': self.form_plugin(a, cls), 'id': a.get('id', ''), 'form_id': a.get('data-form_id', ''),
                             'action': a.get('action', ''), 'labels': [], 'fields': [], 'file_upload': False,
                             'submit': [], 'heading': self.last_heading, 'role': a.get('role', ''), 'class': cls[:80],
                             'in_main': self.cnt['content'] > 0 and self.cnt['chrome'] == 0}
            flags.add('form')
        if self.cur_form is not None:
            self.on_form_child(tag, a, flags)
        # attribute scan: images and videos
        for name, val in attrs:
            if not val:
                continue
            if name in ('srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset'):
                self.on_srcset(val)
                continue
            if '/wp-content/uploads/' in val or 'wp-content\\/uploads' in val:
                v = val.replace('\\/', '/')
                src = self.image_source(tag, name, a)
                for m in UPLOAD_RE.finditer(v):
                    self.add_image(m.group(1), src)
            if self.in_body and tag not in ('meta', 'link') and ('vimeo' in val or 'youtu' in val):
                self.scan_videos(val, tag, name, a)
        if tag not in VOID:
            self.stack.append((tag, frozenset(flags)))
            for f in flags:
                self.cnt[f] += 1

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                break
        else:
            return
        while len(self.stack) > i:
            t, flags = self.stack.pop()
            for f in flags:
                self.cnt[f] -= 1
            if 'title' in flags and self.title_parts is not None:
                self.titles.append(ws(''.join(self.title_parts)))
                self.title_parts = None
            if 'heading' in flags and self.cur_heading is not None:
                lvl, parts = self.cur_heading
                text = ws(''.join(parts))
                self.headings.append((lvl, text))
                if lvl == 1:
                    self.h1.append(text)
                elif lvl == 2:
                    self.h2 += 1
                    if self.cnt['content'] > 0 and self.cnt['chrome'] == 0:
                        self.h2_main += 1
                if text:
                    self.last_heading = f'h{lvl}: {text}'[:160]
                self.cur_heading = None
            if 'a' in flags:
                self.close_link()
            if 'label' in flags and self.label is not None and self.cur_form is not None:
                lt = ws(''.join(self.label))
                if lt and any(ch.isalnum() for ch in lt):
                    self.cur_form['labels'].append(lt)
                self.label = None
            if 'form' in flags and self.cur_form is not None:
                self.close_form()
            if t == 'script':
                self.script_type = ''

    def handle_data(self, data):
        top = self.stack[-1][0] if self.stack else ''
        if top in ('script', 'style'):
            if top == 'style':
                if '/wp-content/uploads/' in data:
                    for m in UPLOAD_RE.finditer(data.replace('\\/', '/')):
                        self.add_image(m.group(1), 'style-block')
            elif 'ld+json' in self.script_type:
                if 'vimeo' in data or 'youtu' in data:
                    self.scan_videos(data, 'script', 'ld+json', {}, sink=self.schema_videos)
                if '/wp-content/uploads/' in data or 'wp-content\\/uploads' in data:
                    for m in UPLOAD_RE.finditer(data.replace('\\/', '/')):
                        self.add_image(m.group(1), 'schema-ld+json')
            elif self.in_body and ('vimeo' in data or 'youtu' in data):
                self.scan_videos(data, 'script', 'inline-js', {}, sink=self.script_videos)
            return
        if self.title_parts is not None:
            self.title_parts.append(data)
        if self.cur_heading is not None:
            self.cur_heading[1].append(data)
        if self.label is not None:
            self.label.append(data)
        if self.cnt['excl'] > 0 or not self.in_body or self.cnt['svg'] > 0:
            return
        if self.cur_link is not None:
            self.cur_link['text'].append(data)
        s = ws(data)
        if not s:
            return
        self.rolling = (self.rolling + ' ' + s)[-400:]
        if self.pending:
            keep = []
            for occ in self.pending:
                occ['text_after'] = (occ['text_after'] + ' ' + s).strip()
                if len(occ['text_after']) < 160:
                    keep.append(occ)
                else:
                    occ['text_after'] = occ['text_after'][:160]
            self.pending = keep
        if self.cnt['chrome'] == 0:
            if self.cnt['content'] > 0:
                self.content_text.append(s)
            self.body_text.append(s)

    # -- element handlers
    def on_meta(self, a):
        name = (a.get('name') or '').strip().lower()
        prop = (a.get('property') or '').strip().lower()
        key = prop or name
        if not key:
            return
        if (key in ('description', 'robots', 'googlebot', 'bingbot', 'google-site-verification', 'generator',
                    'msvalidate.01', 'yandex-verification', 'p:domain_verify', 'facebook-domain-verification')
                or key.startswith(('og:', 'twitter:', 'article:', 'fb:', 'video:', 'profile:'))):
            self.metas.append([key, a.get('content', ''), 'property' if prop else 'name', self.in_body])

    def on_link(self, a):
        rel = (a.get('rel') or '').lower().split()
        href = a.get('href')
        if 'canonical' in rel:
            self.canonicals.append(href)
        if 'alternate' in rel and a.get('hreflang'):
            self.hreflang.append([a.get('hreflang'), href])
        if 'next' in rel or 'prev' in rel:
            self.rel_links.append(['next' if 'next' in rel else 'prev', href])
        if 'stylesheet' in rel and href and '/wp-content/uploads/elementor/css/' in href:
            self.elementor_css.append(href)

    def on_iframe(self, a):
        src = a.get('src') or a.get('data-src') or a.get('data-lazy-src') or ''
        if not src or src.startswith('about:'):
            src = a.get('data-src') or a.get('data-lazy-src') or src
        try:
            host = (urllib.parse.urlsplit(urllib.parse.urljoin(self.base, src)).hostname or '').lower()
        except ValueError:
            host = ''
        info = {'host': host, 'src': src[:400], 'title': a.get('title', ''), 'heading': self.last_heading,
                'in_main': self.cnt['content'] > 0 and self.cnt['chrome'] == 0}
        if MAPS_RE.search(src):
            self.maps.append(info)
        elif 'googletagmanager.com' in host or host.endswith(('youtube.com', 'youtube-nocookie.com', 'vimeo.com')):
            return
        else:
            self.iframes.append(info)

    @staticmethod
    def form_plugin(a, cls):
        if 'frm-fluent-form' in cls or 'fluent_form' in cls:
            return 'fluentform'
        if 'wpcf7-form' in cls:
            return 'cf7'
        if 'elementor-form' in cls:
            return 'elementor'
        if a.get('role') == 'search' or 'search' in cls.lower() or 'search' in (a.get('id') or '').lower():
            return 'search'
        return 'other'

    def on_form_child(self, tag, a, flags):
        f = self.cur_form
        if tag == 'label':
            self.label = []
            flags.add('label')
        elif tag == 'input':
            t = (a.get('type') or 'text').lower()
            if t == 'file':
                f['file_upload'] = True
            if t == 'hidden':
                if a.get('name') == '_wpcf7':
                    f['form_id'] = a.get('value', '')
                return
            if t in ('submit', 'button', 'image'):
                f['submit'].append(a.get('value', ''))
                return
            if (a.get('name') or '').startswith('ak_hp'):
                return
            f['fields'].append({'tag': 'input', 'type': t, 'name': a.get('name', ''),
                                'placeholder': a.get('placeholder', ''), 'required': 'required' in a or a.get('aria-required') == 'true'})
        elif tag in ('textarea', 'select') and not (a.get('name') or '').startswith('ak_hp'):
            f['fields'].append({'tag': tag, 'type': tag, 'name': a.get('name', ''),
                                'placeholder': a.get('placeholder', ''), 'required': 'required' in a or a.get('aria-required') == 'true'})

    def close_form(self):
        f = self.cur_form
        self.cur_form = None
        names = [x['name'] for x in f['fields']]
        if f['plugin'] == 'search' or (names and set(names) <= {'s', 'post_type', 'lang'}):
            self.search_forms += 1
            return
        self.forms.append(f)

    def close_link(self):
        cl = self.cur_link
        self.cur_link = None
        if cl is None:
            return
        text = ws(''.join(cl['text']))
        for occ in cl['videos']:
            occ['link_text'] = text[:160]
        self.links.append([cl['href'], text[:120], cl['chrome'], cl['main']])

    def on_srcset(self, val):
        best, best_w = None, -1.0
        for cand in re.split(r',\s+(?=\S)', val.strip()):
            parts = cand.strip().split()
            if not parts:
                continue
            u = parts[0]
            w = 1.0
            if len(parts) > 1:
                d = parts[1]
                try:
                    w = float(d[:-1]) * (1 if d.endswith('w') else 1000)
                except ValueError:
                    w = 1.0
            if '/wp-content/uploads/' in u and w > best_w:
                best, best_w = u, w
        if best:
            self.add_image(best, 'srcset-largest')

    def image_source(self, tag, name, a):
        if tag == 'img' and name == 'src':
            return 'img-src'
        if name in ('data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-background'):
            return f'{tag}-{name}'
        if name == 'style':
            return 'inline-style'
        if tag == 'a' and name == 'href':
            return 'a-href'
        if tag == 'meta':
            return (a.get('property') or a.get('name') or 'meta').lower()
        if tag == 'link':
            return 'link-' + (a.get('rel') or '').lower().replace(' ', '-')
        if tag in ('video', 'source'):
            return f'{tag}-{name}'
        return f'attr:{tag}[{name}]'


def parse_html(text, base):
    p = PageParser(base)
    try:
        p.feed(text)
        p.close()
    except Exception as e:  # noqa: BLE001
        print(f'parse error {base}: {e!r}', file=sys.stderr)
    while p.stack:
        p.handle_endtag(p.stack[-1][0])
    main_parts = p.content_text if p.has_content else p.body_text
    main = ' '.join(main_parts)
    letters = [c for c in main if c.isalpha()]
    thai = sum(1 for c in letters if '\u0e00' <= c <= '\u0e7f')
    return {
        'v': PARSER_VERSION,
        'lang': p.lang,
        'body_class': p.body_class,
        'titles': p.titles,
        'metas': p.metas,
        'canonicals': p.canonicals,
        'hreflang': p.hreflang,
        'rel_links': p.rel_links,
        'elementor_css': p.elementor_css,
        'h1': p.h1,
        'h2_count': p.h2,
        'h2_count_main': p.h2_main,
        'headings': p.headings[:200],
        'links': p.links,
        'videos': p.videos,
        'schema_videos': p.schema_videos,
        'script_videos': p.script_videos,
        'iframes': p.iframes,
        'maps': p.maps,
        'forms': p.forms,
        'search_forms': p.search_forms,
        'images': p.images,
        'has_content_region': p.has_content,
        'main_text': main,
        'word_count': sum(1 for t in main.split() if any(ch.isalnum() for ch in t)),
        'char_count': sum(1 for c in main if not c.isspace()),
        'thai_ratio': round(thai / len(letters), 3) if letters else 0.0,
    }


def parsed_page(fetcher, url):
    k = Fetcher.key(url)
    pp = PARSE_CACHE / k[:2] / (k + '.json')
    meta = fetcher.cached(url)
    if pp.exists():
        try:
            d = json.loads(pp.read_text('utf-8'))
        except ValueError:
            d = {}
        if d.get('v') == PARSER_VERSION and d.get('fetched_at') == meta.get('fetched_at'):
            return d
    d = parse_html(fetcher.text(url), url)
    d['fetched_at'] = meta.get('fetched_at')
    pp.parent.mkdir(parents=True, exist_ok=True)
    pp.write_text(json.dumps(d, ensure_ascii=False), 'utf-8')
    return d


def is_html(meta):
    return meta and meta.get('status') == 200 and 'html' in (meta.get('content_type') or '').lower()


# --------------------------------------------------------------------------------------------
# Inputs: Search Console xlsx, WordPress export, redirects.md, sitemaps
# --------------------------------------------------------------------------------------------

XNS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
       'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}


def read_xlsx(path):
    z = zipfile.ZipFile(path)
    ss = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall('m:si', XNS):
            ss.append(''.join(t.text or '' for t in si.iter('{%s}t' % XNS['m'])))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    relmap = {r.get('Id'): r.get('Target') for r in rels}
    out = {}
    for s in wb.find('m:sheets', XNS):
        tgt = relmap[s.get('{%s}id' % XNS['r'])].lstrip('/')
        if not tgt.startswith('xl/'):
            tgt = 'xl/' + tgt
        root = ET.fromstring(z.read(tgt))
        rows = []
        for row in root.iter('{%s}row' % XNS['m']):
            r = []
            for c in row.findall('m:c', XNS):
                t, v = c.get('t'), c.find('m:v', XNS)
                if t == 's':
                    val = ss[int(v.text)]
                elif t == 'inlineStr':
                    val = ''.join(x.text or '' for x in c.iter('{%s}t' % XNS['m']))
                else:
                    val = v.text if v is not None else None
                r.append(val)
            rows.append(r)
        out[s.get('name')] = rows
    return out


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def load_search_console():
    """Return {raw_url: {...}} with performance numbers and coverage states, plus a list of report names."""
    sc = collections.defaultdict(lambda: {'clicks': 0.0, 'impressions': 0.0, 'position': None, 'ctr': None,
                                          'coverage': [], 'internal_links': None, 'external_links': None,
                                          'reports': []})
    for f in sorted(SC_DIR.glob('*.xlsx')):
        d = read_xlsx(f)
        name = f.name
        if 'Pages' in d and 'Queries' in d:
            for r in d['Pages'][1:]:
                if not r or not r[0] or not r[0].startswith(('http://', 'https://')):
                    continue
                e = sc[r[0]]
                e['clicks'] += fnum(r[1])
                e['impressions'] += fnum(r[2])
                e['ctr'] = fnum(r[3])
                e['position'] = fnum(r[4])
                e['reports'].append('performance')
        elif 'Table' in d:
            rows = d['Table']
            meta = {r[0]: r[1] for r in d.get('Metadata', [])[1:] if r}
            header = rows[0] if rows else []
            if 'Coverage-Valid' in name:
                issue = 'Indexed'
            elif 'Issue' in meta:
                issue = meta['Issue']
            else:
                issue = None
            for r in rows[1:]:
                # only URL rows; the "Top linking sites" export lists external domains
                if not r or not r[0] or not r[0].startswith(('http://', 'https://')):
                    continue
                e = sc[r[0]]
                if issue:
                    if issue not in e['coverage']:
                        e['coverage'].append(issue)
                    e['reports'].append('coverage')
                elif header and header[0] == 'Target page' and len(header) > 1:
                    if header[1] == 'Internal links':
                        e['internal_links'] = fnum(r[1])
                        e['reports'].append('top-internal-links')
                    elif header[1] == 'Incoming links':
                        e['external_links'] = fnum(r[1])
                        e['reports'].append('top-external-links')
    return sc


WP = {'wp': 'http://wordpress.org/export/1.2/', 'content': 'http://purl.org/rss/1.0/modules/content/'}
# Taxonomy -> archive base path, e.g. {'category': '/category/', 'post_tag': '/tag/'} (oldSite.taxonomies).
TAX_BASE = OLD.get('taxonomies') or {'category': '/category/', 'post_tag': '/tag/'}


def lang_prefix(path):
    """'/en' for a path under /en/ (a prefixed language), '' for the default language."""
    seg = path.split('/')[1] if path.startswith('/') else ''
    return '/' + seg if seg in LANGS[1:] else ''


def load_export():
    if not EXPORT.exists():
        print(f'no WordPress export at {EXPORT.relative_to(REPO)}: skipped', file=sys.stderr)
        return {'items': [], 'terms': [], 'authors': []}
    ch = ET.parse(EXPORT).getroot().find('channel')
    items = []
    for it in ch.findall('item'):
        metas = collections.defaultdict(list)
        for pm in it.findall('wp:postmeta', WP):
            metas[pm.findtext('wp:meta_key', namespaces=WP)].append(pm.findtext('wp:meta_value', namespaces=WP))
        items.append({
            'id': it.findtext('wp:post_id', namespaces=WP),
            'type': it.findtext('wp:post_type', namespaces=WP),
            'status': it.findtext('wp:status', namespaces=WP),
            'title': it.findtext('title') or '',
            'link': it.findtext('link') or '',
            'name': it.findtext('wp:post_name', namespaces=WP) or '',
            'parent': it.findtext('wp:post_parent', namespaces=WP),
            'date': it.findtext('wp:post_date', namespaces=WP) or '',
            'old_slugs': [s for s in metas.get('_wp_old_slug', []) if s],
            'robots': metas.get('rank_math_robots', []),
            'cats': [(c.get('domain'), c.get('nicename')) for c in it.findall('category')],
            'attached_file': (metas.get('_wp_attached_file') or [None])[0],
            'content': it.findtext('content:encoded', namespaces=WP) or '',
        })
    terms = []
    for c in ch.findall('wp:category', WP):
        terms.append(('category', c.findtext('wp:category_nicename', namespaces=WP)))
    for c in ch.findall('wp:tag', WP):
        terms.append(('post_tag', c.findtext('wp:tag_slug', namespaces=WP)))
    for c in ch.findall('wp:term', WP):
        terms.append((c.findtext('wp:term_taxonomy', namespaces=WP), c.findtext('wp:term_slug', namespaces=WP)))
    authors = [a.findtext('wp:author_login', namespaces=WP) for a in ch.findall('wp:author', WP)]
    return {'items': items, 'terms': terms, 'authors': authors}


def load_redirects_md():
    """Parse the tables in redirects.md. Returns a list of {section, ref, source, target, note}."""
    rules = []
    section = None
    if not REDIRECTS_MD.exists():
        return rules
    for line in REDIRECTS_MD.read_text('utf-8').splitlines():
        m = re.match(r'^## ([A-D])\.', line)
        if m:
            section = m.group(1)
            continue
        if section is None or not line.startswith('|') or line.startswith('| ---'):
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if section == 'A':
            if len(cells) < 3:
                continue
            ref, src_cell, tgt_cell = cells[0], cells[1], cells[2]
        else:
            ref, src_cell, tgt_cell = '', cells[0], (cells[1] if len(cells) > 1 else '')
        srcs = [x for x in re.findall(r'`([^`]+)`', src_cell) if x.startswith('/') and '…' not in x]
        tgts = [x for x in re.findall(r'`([^`]+)`', tgt_cell) if x.startswith('/')]
        for src in srcs:
            tgt = tgts[0] if tgts else None
            if tgt is None and 'same path with a slash' in tgt_cell:
                tgt = src.rstrip('/') + '/'
            rules.append({'section': section, 'ref': ref, 'source': src, 'target': tgt,
                          'note': tgt_cell if section == 'D' else ''})
    return rules


def parse_sitemap(text):
    """Return (kind, [locs], {loc: [video entries]})."""
    try:
        root = ET.fromstring(text.encode('utf-8'))
    except ET.ParseError:
        return 'invalid', [], {}
    sm = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
    vn = '{http://www.google.com/schemas/sitemap-video/1.1}'
    if root.tag.endswith('sitemapindex'):
        return 'index', [e.findtext(sm + 'loc').strip() for e in root.findall(sm + 'sitemap')], {}
    locs, videos = [], {}
    for u in root.findall(sm + 'url'):
        loc = (u.findtext(sm + 'loc') or '').strip()
        locs.append(loc)
        vs = []
        for v in u.findall(vn + 'video'):
            vs.append({k: (v.findtext(vn + k) or '').strip() for k in
                       ('title', 'description', 'player_loc', 'content_loc', 'thumbnail_loc', 'duration', 'publication_date')})
        if vs:
            videos[loc] = vs
    return 'urlset', locs, videos


def video_id(url):
    if not url:
        return None, None
    u = url.replace('\\/', '/')
    m = VIMEO_RE.search(u)
    if m:
        return 'vimeo', m.group(1)
    m = YT_RE.search(u)
    if m:
        return 'youtube', m.group(1)
    return None, None


# --------------------------------------------------------------------------------------------
# Crawl
# --------------------------------------------------------------------------------------------

class Crawl:
    def __init__(self, fetcher):
        self.F = fetcher
        self.found = collections.OrderedDict()   # url -> OrderedDict(source -> None)
        self.noise = collections.defaultdict(lambda: {'reason': None, 'sources': []})
        self.queue = collections.deque()
        self.sitemaps = collections.OrderedDict()  # sitemap url -> list of locs
        self.sitemap_of = collections.defaultdict(list)  # url -> sitemap names
        self.video_sitemap = {}  # url -> [entries]
        self.css = collections.OrderedDict()  # css url -> pages
        self.sc_raw = {}
        self.sc = {}  # normalised url -> aggregated
        self.sc_noise = []
        self.export = None
        self.export_by_url = {}
        self.old_slug_urls = {}  # url -> item
        self.rd_rules = []

    def add(self, url, source):
        if url not in self.found:
            if len(self.found) >= MAX_URLS:
                return
            self.found[url] = collections.OrderedDict()
            self.queue.append(url)
        self.found[url][source] = None

    def add_raw(self, href, source, base=ORIGIN + '/'):
        url, reason = normalize(href, base)
        if url is None:
            return None, reason
        if reason is None:
            self.add(url, source)
        else:
            n = self.noise[url]
            n['reason'] = reason
            if len(n['sources']) < 20 and source not in n['sources']:
                n['sources'].append(source)
        return url, reason

    # -- seeds
    def seed_sitemaps(self):
        robots_url = ORIGIN + '/robots.txt'
        meta = self.F.get(robots_url)
        sm_urls = []
        if meta and meta.get('status') == 200:
            for line in self.F.text(robots_url).splitlines():
                if line.lower().startswith('sitemap:'):
                    sm_urls.append(line.split(':', 1)[1].strip())
        if not sm_urls:
            sm_urls = [ORIGIN + '/sitemap_index.xml']
        todo = collections.deque(sm_urls)
        seen = set()
        while todo:
            su = todo.popleft()
            if su in seen:
                continue
            seen.add(su)
            meta = self.F.get(su)
            if not meta or meta.get('status') != 200:
                self.sitemaps[su] = None
                continue
            kind, locs, videos = parse_sitemap(self.F.text(su))
            if kind == 'index':
                self.sitemaps[su] = []
                todo.extend(locs)
                continue
            self.sitemaps[su] = locs
            name = su.rsplit('/', 1)[-1]
            for loc in locs:
                url, reason = self.add_raw(loc, 'sitemap:' + name)
                if url:
                    self.sitemap_of[url].append(name)
            for loc, vs in videos.items():
                url, _ = normalize(loc)
                if url:
                    self.video_sitemap.setdefault(url, []).extend(vs)

    def seed_search_console(self):
        raw = load_search_console()
        self.sc_raw = raw
        agg = {}
        for ru, e in raw.items():
            url, reason = normalize(ru)
            if url is None:
                continue
            tags = []
            if 'performance' in e['reports']:
                tags.append('search-console:performance')
            if 'coverage' in e['reports']:
                tags += ['search-console:coverage:' + c for c in e['coverage']]
            if 'top-internal-links' in e['reports']:
                tags.append('search-console:top-internal-links')
            if 'top-external-links' in e['reports']:
                tags.append('search-console:top-external-links')
            for t in tags or ['search-console']:
                self.add_raw(ru, t)
            a = agg.setdefault(url, {'raw': [], 'clicks': 0.0, 'impressions': 0.0, 'position': None, 'coverage': [],
                                     'internal_links': None, 'external_links': None, 'noise_reason': reason})
            a['raw'].append(ru)
            a['clicks'] += e['clicks']
            if e['impressions'] > a['impressions'] or a['position'] is None:
                a['position'] = e['position'] if e['impressions'] else a['position']
            a['impressions'] += e['impressions']
            for c in e['coverage']:
                c2 = c if ru == url else f'{c} (as {ru})'
                if c2 not in a['coverage']:
                    a['coverage'].append(c2)
            if e['internal_links'] is not None:
                a['internal_links'] = e['internal_links']
            if e['external_links'] is not None:
                a['external_links'] = e['external_links']
        self.sc = agg

    def seed_export(self):
        exp = load_export()
        self.export = exp
        public_types = ('page', 'post', *POST_TYPES)
        attach_parent, attach_orphan = 0, 0
        months = set()
        for it in exp['items']:
            link = it['link']
            if it['type'] == 'attachment':
                # a small sample of attachment pages, to learn how WordPress / Rank Math treats them
                if it['parent'] and it['parent'] != '0' and attach_parent < 3:
                    attach_parent += 1
                    self.add_raw(link, 'export:attachment-page-sample')
                elif (not it['parent'] or it['parent'] == '0') and attach_orphan < 3:
                    attach_orphan += 1
                    self.add_raw(link, 'export:attachment-page-sample')
                continue
            if it['type'] not in public_types or it['status'] != 'publish':
                continue
            url, reason = self.add_raw(link, 'export:' + it['type'])
            if url:
                self.export_by_url[url] = it
            path = urllib.parse.urlsplit(link).path
            pre = lang_prefix(path)
            for old in it['old_slugs']:
                parent = path.rstrip('/').rsplit('/', 1)[0]
                ou = parent + '/' + old.strip('/') + '/'
                u, r = self.add_raw(ou, 'export:_wp_old_slug')
                if u and r is None:
                    self.old_slug_urls.setdefault(u, it)
            for dom, nice in it['cats']:
                if dom in TAX_BASE and nice:
                    self.add_raw(pre + TAX_BASE[dom] + nice + '/', 'export-derived:term-of-item')
            if it['type'] == 'post' and it['date'][:7]:
                months.add((pre, it['date'][:4], it['date'][5:7]))
        for tax, slug in exp['terms']:
            if tax in TAX_BASE and slug:
                self.add_raw(TAX_BASE[tax] + slug + '/', 'export-derived:term')
        for pre, y, m in sorted(months):
            self.add_raw(f'{pre}/{y}/{m}/', 'export-derived:date-archive')
            self.add_raw(f'{pre}/{y}/', 'export-derived:date-archive')
        for login in exp['authors']:
            if login:
                nice = re.sub(r'[^a-z0-9_-]+', '-', login.lower()).strip('-')
                self.add_raw(f'/author/{nice}/', 'export-derived:author')

    def seed_redirects_md(self):
        self.rd_rules = load_redirects_md()
        for r in self.rd_rules:
            self.add_raw(r['source'], f"redirects.md:{r['section']}{r['ref']}")
            if r['target']:
                self.add_raw(r['target'], 'redirects.md:target')

    # -- main loop
    def run(self):
        self.add(ORIGIN + '/', 'start')
        self.seed_sitemaps()
        self.seed_search_console()
        self.seed_export()
        self.seed_redirects_md()
        n = 0
        while self.queue:
            url = self.queue.popleft()
            meta = self.F.get(url)
            n += 1
            if meta is None:
                continue
            st = meta.get('status')
            if st and 300 <= st < 400 and meta.get('location'):
                self.add_raw(meta['location'], 'redirect-from:' + url, base=url)
            elif is_html(meta):
                d = parsed_page(self.F, url)
                for href, _text, _chrome, _main in d['links']:
                    self.add_raw(href, 'link-from:' + url, base=url)
                for _lang, href in d['hreflang']:
                    self.add_raw(href, 'hreflang-from:' + url, base=url)
                for href in d['canonicals']:
                    self.add_raw(href, 'canonical-from:' + url, base=url)
                for _rel, href in d['rel_links']:
                    self.add_raw(href, 'rel-next-prev-from:' + url, base=url)
                for href in d['elementor_css']:
                    cu = urllib.parse.urljoin(url, href).split('?')[0].split('#')[0]
                    cu = ORIGIN + quote_path(urllib.parse.urlsplit(cu).path)
                    self.css.setdefault(cu, []).append(url)
        # Elementor CSS files: background images used by pages
        for cu in self.css:
            self.F.get(cu)


# --------------------------------------------------------------------------------------------
# Build outputs
# --------------------------------------------------------------------------------------------

MULTI_OK = {'og:image', 'og:image:secure_url', 'og:image:width', 'og:image:height', 'og:image:alt', 'og:image:type',
            'og:video', 'og:video:secure_url', 'og:video:width', 'og:video:height', 'og:video:type',
            'og:locale:alternate', 'article:tag', 'video:tag', 'og:audio', 'twitter:image'}


def lang_of(d, url):
    lang = (d or {}).get('lang') or ''
    for code in LANGS:
        if lang.lower().startswith(code.lower()):
            return code
    if lang:
        return lang
    path = decode(urllib.parse.urlsplit(url).path)
    pre = lang_prefix(path.rstrip('/') + '/')
    return pre[1:] if pre else LANG_DEFAULT


def archive_type(tax):
    """Inventory type of a taxonomy archive: 'tag' for post_tag, otherwise the taxonomy name."""
    return 'tag' if tax == 'post_tag' else tax


def classify(url, d, sm_names, export_type):
    path = decode(urllib.parse.urlsplit(url).path)
    pre = lang_prefix(path.rstrip('/') + '/')
    p = path[len(pre):]
    if p in ('', '/'):
        return 'home'
    if re.search(r'/page/\d+/?$', p):
        return 'pagination'
    if re.match(r'^/\d{4}(/\d{1,2}){0,2}/?$', p):
        return 'date-archive'
    for base, t in [('/author/', 'author')] + [(b, archive_type(tax)) for tax, b in TAX_BASE.items()]:
        if p.startswith(base):
            return t
    for pt in POST_TYPES.values():
        if pt.get('path') and re.match(pt['path'], p):
            return pt['type']
    bc = ((d or {}).get('body_class') or '').split()
    for name, pt in POST_TYPES.items():
        if 'single-' + name in bc:
            return pt['type']
    if 'single-post' in bc:
        return 'post'
    if export_type == 'post' or 'post-sitemap.xml' in sm_names:
        return 'post'
    if export_type in POST_TYPES:
        return POST_TYPES[export_type]['type']
    if 'page' in bc or export_type == 'page' or 'page-sitemap.xml' in sm_names:
        return 'page'
    return 'other'


def social_issues(metas):
    groups = collections.OrderedDict()
    for key, val, _attr, in_body in metas:
        if key.startswith(('og:', 'twitter:', 'article:', 'fb:')):
            groups.setdefault(key, []).append(val)
    issues = []
    for k, vals in groups.items():
        if any(v.strip() == '' for v in vals):
            issues.append(f'{k}: empty value')
        if len(vals) > 1 and k not in MULTI_OK:
            uniq = list(dict.fromkeys(vals))
            if len(uniq) == 1:
                issues.append(f'{k}: duplicated x{len(vals)}')
            else:
                issues.append(f'{k}: conflict ' + ' | '.join(u[:80] for u in uniq))
        if k in ('twitter:site', 'twitter:creator') and any(re.search(r'https?://', v) for v in vals):
            issues.append(f'{k}: malformed ({vals[0]})')
    return groups, issues


def resolve_chain(F, url, max_hops=12):
    chain = []
    cur = url
    seen = set()
    notes = []
    while True:
        meta = F.cached(cur)
        if meta is None:
            chain.append([cur, None])
            notes.append('not fetched')
            break
        st = meta.get('status')
        chain.append([cur, st])
        if st and 300 <= st < 400:
            loc = meta.get('location')
            nu, reason = normalize(loc, cur) if loc else (None, 'no-location')
            if nu is None:
                chain.append([loc, 'external' if reason == 'external' else reason])
                break
            if reason is not None:
                chain.append([nu, 'not fetched (' + reason + ')'])
                break
            if loc and not re.match(re.escape(ORIGIN) + r'(/|$)', loc) and loc.startswith('http'):
                notes.append('Location uses a non-canonical host/scheme: ' + loc)
            if nu in seen or len(chain) > max_hops:
                notes.append('redirect loop')
                break
            seen.add(cur)
            cur = nu
        else:
            break
    return chain, notes


def sc_for(crawl, url):
    return crawl.sc.get(url)


HONEYPOT_LABEL = re.compile(r'^(Δ|.{0,1}|please leave this field empty\.?)$', re.I)


def clean_form(f):
    """Drop honeypot fields and labels, and name the catalog sort form."""
    fields = [x for x in f['fields'] if 'ak_hp' not in (x['name'] or '') and 'honeypot' not in (x['name'] or '').lower()]
    plugin = f['plugin']
    if plugin == 'other' and 'product_order' in (f.get('class') or ''):
        plugin = 'catalog-sort (Post Type X, not a submission form)'
    return {'plugin': plugin, 'form_id': f['form_id'], 'html_id': f['id'],
            'labels': [l for l in f['labels'] if not HONEYPOT_LABEL.match(l.strip())],
            'fields': [x['name'] or x['placeholder'] for x in fields],
            'field_types': [x['type'] for x in fields],
            'placeholders': [x['placeholder'] for x in fields if x['placeholder']],
            'required': [x['name'] for x in fields if x['required']],
            'file_upload': f['file_upload'], 'heading': f['heading'], 'in_main': f.get('in_main')}


def build(crawl, F):
    out = {}
    records = []
    pages = {}  # url -> parsed (200 HTML only)
    redirects_md_by_src = {}
    for r in crawl.rd_rules:
        u, _ = normalize(r['source'])
        if u:
            redirects_md_by_src.setdefault(u, []).append(r)

    # Elementor CSS -> images
    css_images = {}
    for cu, pg in crawl.css.items():
        meta = F.cached(cu)
        imgs = []
        if meta and meta.get('status') == 200:
            txt = F.text(cu)
            for m in UPLOAD_RE.finditer(txt.replace('\\/', '/')):
                u = upload_url(m.group(1), cu)
                if u and u not in imgs:
                    imgs.append(u)
        css_images[cu] = imgs

    for url, sources in crawl.found.items():
        meta = F.cached(url)
        rec = collections.OrderedDict()
        rec['url'] = url
        rec['url_decoded'] = decode(url)
        rec['status'] = meta.get('status') if meta else None
        if meta and meta.get('error'):
            rec['error'] = meta['error']
        if not meta:
            rec['error'] = 'not fetched'
        d = None
        if is_html(meta):
            d = parsed_page(F, url)
            pages[url] = d
        chain, notes = resolve_chain(F, url) if meta else ([[url, None]], ['not fetched'])
        if len(chain) > 1:
            rec['redirect_location'] = meta.get('location')
            rec['redirect_by'] = ', '.join((meta.get('headers') or {}).get('x-redirect-by', []))
            rec['final_url'] = chain[-1][0]
            rec['final_url_decoded'] = decode(chain[-1][0])
            rec['final_status'] = chain[-1][1]
            rec['redirect_hops'] = len(chain) - 1
            rec['redirect_chain'] = chain
            if notes:
                rec['redirect_notes'] = notes
        sm_names = crawl.sitemap_of.get(url, [])
        exp = crawl.export_by_url.get(url)
        rec['lang'] = lang_of(d, url)
        rec['type'] = classify(url, d, sm_names, exp['type'] if exp else None)
        m = re.search(r'^(.*?/)page/\d+/?$', decode(urllib.parse.urlsplit(url).path))
        if m:
            rec['pagination_of'] = m.group(1)
        hdrs = (meta or {}).get('headers') or {}
        rec['content_type'] = (meta or {}).get('content_type')
        rec['x_robots_tag'] = ', '.join(hdrs.get('x-robots-tag', [])) or None
        if d:
            bc = d['body_class'].split()
            wid = next((c.split('-')[-1] for c in bc if re.match(r'^(postid|page-id)-\d+$', c)), None)
            rec['wp_id'] = wid
            rec['wp_template'] = ' '.join(c for c in bc if re.match(r'^(single-|page-template|tax-|archive$|category$|tag$|blog$|search$|error404$|home$|post-type-archive)', c)) or None
            metas = d['metas']
            by = collections.defaultdict(list)
            for k, v, _a, _b in metas:
                by[k].append(v)
            rec['title'] = d['titles'][0] if d['titles'] else None
            if len(d['titles']) > 1:
                rec['titles_all'] = d['titles']
            rec['meta_description'] = by['description'][0] if by['description'] else None
            if len(by['description']) > 1:
                rec['meta_descriptions_all'] = by['description']
            rec['canonical'] = d['canonicals'][0] if d['canonicals'] else None
            if len(d['canonicals']) > 1:
                rec['canonicals_all'] = d['canonicals']
            cn = normalize(rec['canonical'], url)[0] if rec['canonical'] else None
            rec['canonical_is_self'] = (cn == url) if cn else None
            rec['robots'] = by['robots'][0] if by['robots'] else None
            if len(by['robots']) > 1:
                rec['robots_all'] = by['robots']
            robots_all = ' '.join(by['robots'] + by['googlebot'] + [rec['x_robots_tag'] or '']).lower()
            rec['noindex'] = 'noindex' in robots_all
            rec['nofollow'] = 'nofollow' in robots_all
            rec['hreflang'] = {k: v for k, v in d['hreflang']}
            groups, issues = social_issues(metas)
            rec['og'] = {k: (v[0] if len(v) == 1 else v) for k, v in groups.items() if k.startswith(('og:', 'article:', 'fb:'))}
            rec['twitter'] = {k: (v[0] if len(v) == 1 else v) for k, v in groups.items() if k.startswith('twitter:')}
            rec['social_tag_issues'] = issues
            verif = {k: by[k] for k in ('google-site-verification', 'msvalidate.01', 'facebook-domain-verification') if by[k]}
            if verif:
                rec['verification'] = verif
            rec['h1'] = d['h1']
            rec['h1_count'] = len(d['h1'])
            rec['h2_count'] = d['h2_count']
            rec['h2_count_main'] = d['h2_count_main']
            rec['word_count'] = d['word_count']
            rec['char_count'] = d['char_count']
            rec['thai_ratio'] = d['thai_ratio']
        # where found
        src_list = [s for s in sources.keys() if s.split(':', 1)[-1] != url]  # drop self-references
        link_from = [s for s in src_list if s.startswith('link-from:')]
        other = [s for s in src_list if not s.startswith('link-from:')]
        rec['found_in'] = other + link_from[:10]
        rec['link_from_count'] = len(link_from)
        rec['in_sitemaps'] = sm_names
        sc = crawl.sc.get(url)
        if sc:
            rec['search_console'] = {'clicks': sc['clicks'], 'impressions': sc['impressions'], 'position': sc['position'],
                                     'coverage': sc['coverage'], 'internal_links': sc['internal_links'],
                                     'external_links': sc['external_links'], 'raw_urls': sc['raw']}
        if exp:
            rec['export'] = {'post_type': exp['type'], 'post_id': exp['id'], 'title': exp['title'], 'date': exp['date'],
                             'rank_math_robots': exp['robots']}
        if url in crawl.old_slug_urls:
            it = crawl.old_slug_urls[url]
            rec['old_slug_of'] = {'post_type': it['type'], 'post_id': it['id'], 'current_url': it['link']}
        if url in crawl.video_sitemap:
            rec['video_sitemap'] = crawl.video_sitemap[url]
        if url in redirects_md_by_src:
            rec['redirects_md'] = [{'section': r['section'], 'rule': r['ref'], 'target': r['target']} for r in redirects_md_by_src[url]]
        if d:
            yt, vm = collections.OrderedDict(), collections.OrderedDict()
            for occ in d['videos']:
                tgt = yt if occ['provider'] == 'youtube' else vm
                e = tgt.setdefault(occ['id'], {'id': occ['id'], 'count': 0, 'in_main': False, 'contexts': []})
                e['count'] += 1
                e['in_main'] = e['in_main'] or occ['in_main']
                if occ.get('hash'):
                    e['hash'] = occ['hash']
                if len(e['contexts']) < 3:
                    e['contexts'].append({k: occ[k] for k in ('element', 'attr', 'title_attr', 'heading', 'link_text', 'text_before', 'text_after') if occ.get(k)})
            og_videos = [video_id(v) for v in (by.get('og:video') or [])]
            rec['embeds'] = {
                'youtube': list(yt.values()),
                'vimeo': list(vm.values()),
                'youtube_ids': list(yt.keys()),
                'vimeo_ids': list(vm.keys()),
                'og_video_ids': [f'{p}:{i}' for p, i in og_videos if p],
                'schema_video_ids': [f'{p}:{i}' for p, i in d['schema_videos']],
                'inline_script_video_ids': [f'{p}:{i}' for p, i in d['script_videos']],
                'iframes': d['iframes'],
                'maps': d['maps'],
                'forms': [clean_form(f) for f in d['forms']],
            }
            imgs = collections.OrderedDict((u, list(s)) for u, s in d['images'].items())
            for href in d['elementor_css']:
                cu = ORIGIN + quote_path(urllib.parse.urlsplit(urllib.parse.urljoin(url, href)).path)
                for u in css_images.get(cu, []):
                    imgs.setdefault(u, [])
                    tag = 'elementor-css:' + cu.rsplit('/', 1)[-1]
                    if tag not in imgs[u]:
                        imgs[u].append(tag)
            rec['images'] = [{'url': u, 'sources': s} for u, s in imgs.items()
                             if u.rsplit('.', 1)[-1].lower() in IMAGE_EXT]
            rec['uploads_other'] = [{'url': u, 'sources': s} for u, s in imgs.items()
                                    if u.rsplit('.', 1)[-1].lower() not in IMAGE_EXT]
        records.append(rec)
    out['records'] = records
    out['pages'] = pages
    out['css_images'] = css_images
    return out


# --------------------------------------------------------------------------------------------
# Writers
# --------------------------------------------------------------------------------------------

def write_urls_json(recs):
    data = {
        'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'origin': ORIGIN,
        'count': len(recs),
        'urls': recs,
    }
    (HERE / 'urls.json').write_text(json.dumps(data, ensure_ascii=False, indent=1), 'utf-8')


def write_redirects_csv(crawl, F, recs):
    by_url = {r['url']: r for r in recs}
    rows = collections.OrderedDict()

    def row_for(u):
        if u not in rows:
            rows[u] = {'from': u, 'from_decoded': decode(u), 'status': None, 'to': '', 'to_decoded': '', 'redirect_by': '',
                       'final_url': '', 'final_status': '', 'hops': 0, 'chain': 'no', 'redirect_to_404': 'no',
                       'location_raw': '', 'source': [], 'expected_target': '', 'matches_expected': '', 'search_console': '',
                       'notes': []}
        return rows[u]

    for r in recs:
        if r.get('status') and 300 <= r['status'] < 400:
            row = row_for(r['url'])
            row['source'].append('crawl')
    for rule in crawl.rd_rules:
        u, reason = normalize(rule['source'])
        if not u:
            continue
        row = row_for(u)
        label = {'A': 'plugin list in redirects.md', 'B': 'redirects.md B (WP changed slug)',
                 'C': 'redirects.md C (WP guessed)', 'D': 'redirects.md D (host/archive/other)'}[rule['section']]
        row['source'].append(label + (f" #{rule['ref']}" if rule['ref'] else ''))
        if rule['target']:
            row['expected_target'] = rule['target']
    for u, it in crawl.old_slug_urls.items():
        row = row_for(u)
        row['source'].append(f"wp _wp_old_slug ({it['type']} {it['id']})")
        if not row['expected_target']:
            row['expected_target'] = decode(urllib.parse.urlsplit(it['link']).path)
    for u, row in rows.items():
        r = by_url.get(u)
        meta = F.cached(u)
        if r is None or meta is None:
            row['status'] = 'not fetched'
            row['notes'].append('not crawled (noise or outside crawl)')
            continue
        row['status'] = r['status']
        if 'crawl' not in row['source'] and r['status'] and 300 <= r['status'] < 400:
            row['source'].insert(0, 'crawl')
        if r.get('redirect_chain'):
            chain = r['redirect_chain']
            row['to'] = chain[1][0] if len(chain) > 1 else ''
            row['to_decoded'] = decode(row['to'])
            row['location_raw'] = r.get('redirect_location') or ''
            row['redirect_by'] = r.get('redirect_by') or ''
            row['final_url'] = r.get('final_url_decoded') or ''
            row['final_status'] = r.get('final_status')
            row['hops'] = r.get('redirect_hops')
            row['chain'] = 'yes' if (r.get('redirect_hops') or 0) > 1 else 'no'
            fs = r.get('final_status')
            row['redirect_to_404'] = 'yes' if isinstance(fs, int) and fs >= 400 else 'no'
            for n in r.get('redirect_notes', []):
                row['notes'].append(n)
        else:
            row['final_status'] = r['status']
            if r['status'] == 200:
                row['notes'].append('no redirect: URL answers 200 itself')
            elif r['status'] and r['status'] >= 400:
                row['notes'].append(f"no redirect: URL returns {r['status']}")
        if row['expected_target']:
            exp_u = normalize(row['expected_target'])[0]
            fin = normalize(r.get('final_url') or u)[0]
            to = normalize(row['to'])[0] if row['to'] else None
            row['matches_expected'] = 'yes' if exp_u in (fin, to) else 'no'
        sc = crawl.sc.get(u)
        if sc:
            row['search_console'] = f"clicks {sc['clicks']:.0f}, impressions {sc['impressions']:.0f}" + (
                f", coverage: {'; '.join(sc['coverage'])}" if sc['coverage'] else '')
    cols = ['from_decoded', 'status', 'to_decoded', 'redirect_by', 'final_url', 'final_status', 'hops', 'chain',
            'redirect_to_404', 'source', 'expected_target', 'matches_expected', 'search_console', 'notes', 'from', 'to',
            'location_raw']
    with open(HERE / 'redirects.csv', 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        def sk(item):
            row = item[1]
            st = row['status'] if isinstance(row['status'], int) else 999
            return (0 if 300 <= st < 400 else 1, row['from_decoded'])
        for u, row in sorted(rows.items(), key=sk):
            vals = []
            for c in cols:
                v = row[c]
                if isinstance(v, list):
                    v = '; '.join(dict.fromkeys(v))
                vals.append('' if v is None else v)
            w.writerow(vals)
    return rows


def write_vimeo_csv(crawl, recs):
    rows = []
    for r in recs:
        if r.get('status') != 200 or 'embeds' not in r:
            continue
        e = r['embeds']
        page_ids = set(e['vimeo_ids'])
        vs_titles = {}
        for v in r.get('video_sitemap', []):
            p, i = video_id(v.get('player_loc') or v.get('content_loc'))
            if p == 'vimeo':
                vs_titles[i] = v.get('title', '')
        for v in e['vimeo']:
            c = v['contexts'][0] if v['contexts'] else {}
            rows.append({'vimeo_id': v['id'], 'hash': v.get('hash', ''), 'where': 'page markup' if v['in_main'] else 'page markup (outside main content)',
                         'page': r['url_decoded'], 'lang': r['lang'], 'type': r['type'], 'page_title': r.get('title') or '',
                         'h1': ' | '.join(r.get('h1') or []), 'occurrences_on_page': v['count'],
                         'element': f"{c.get('element', '')}[{c.get('attr', '')}]", 'title_attr': c.get('title_attr', ''),
                         'link_text': c.get('link_text', ''), 'heading_before': c.get('heading', ''),
                         'text_before': c.get('text_before', ''), 'text_after': c.get('text_after', ''),
                         'video_sitemap_title': vs_titles.get(v['id'], ''),
                         'also_in_og_video': 'yes' if f"vimeo:{v['id']}" in e['og_video_ids'] else 'no'})
        meta_only = collections.OrderedDict()
        for x in e['og_video_ids']:
            p, i = x.split(':', 1)
            if p == 'vimeo' and i not in page_ids:
                meta_only.setdefault(i, []).append('og:video')
        for x in e['schema_video_ids']:
            p, i = x.split(':', 1)
            if p == 'vimeo' and i not in page_ids:
                meta_only.setdefault(i, []).append('JSON-LD schema')
        for i in vs_titles:
            if i not in page_ids:
                meta_only.setdefault(i, []).append('video sitemap')
        for i, where in meta_only.items():
            rows.append({'vimeo_id': i, 'hash': '', 'where': 'metadata only: ' + ', '.join(dict.fromkeys(where)) + ' (not played on page)',
                         'page': r['url_decoded'], 'lang': r['lang'], 'type': r['type'], 'page_title': r.get('title') or '',
                         'h1': ' | '.join(r.get('h1') or []), 'occurrences_on_page': 0, 'element': '', 'title_attr': '',
                         'link_text': '', 'heading_before': '', 'text_before': '', 'text_after': '',
                         'video_sitemap_title': vs_titles.get(i, ''), 'also_in_og_video': 'yes' if 'og:video' in where else 'no'})
    pages_per_id = collections.defaultdict(set)
    for row in rows:
        if row['occurrences_on_page']:
            pages_per_id[row['vimeo_id']].add(row['page'])
    for row in rows:
        row['pages_with_this_id'] = len(pages_per_id.get(row['vimeo_id'], ()))
    cols = ['vimeo_id', 'hash', 'pages_with_this_id', 'page', 'lang', 'type', 'where', 'page_title', 'h1',
            'occurrences_on_page', 'element', 'title_attr', 'link_text', 'heading_before', 'text_before', 'text_after',
            'video_sitemap_title', 'also_in_og_video']
    rows.sort(key=lambda x: (x['occurrences_on_page'] == 0, int(x['vimeo_id']), x['page']))
    with open(HERE / 'vimeo.csv', 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for row in rows:
            w.writerow({c: row.get(c, '') for c in cols})
    return rows


SIZE_SUFFIX = re.compile(r'-\d+x\d+(?=\.[a-z0-9]+$)', re.I)
SCALED_SUFFIX = re.compile(r'-(scaled|rotated)(?=\.[a-z0-9]+$)', re.I)


def write_images_csv(recs):
    imgs = collections.OrderedDict()
    for r in recs:
        if r.get('status') != 200 or 'images' not in r:
            continue
        for im in r['images']:
            e = imgs.setdefault(im['url'], {'pages': [], 'sources': collections.OrderedDict()})
            e['pages'].append(r['url_decoded'][len(ORIGIN):])
            for s in im['sources']:
                s2 = 'elementor-css' if s.startswith('elementor-css:') else s
                e['sources'][s2] = None
    n200 = sum(1 for r in recs if r.get('status') == 200 and r.get('content_type', '').startswith('text/html'))
    rows = []
    for u, e in imgs.items():
        dec = decode(u)
        fname = dec.rsplit('/', 1)[-1]
        orig = SIZE_SUFFIX.sub('', dec)
        rows.append({'image_url': dec, 'ext': fname.rsplit('.', 1)[-1].lower(), 'is_size_variant': 'yes' if SIZE_SUFFIX.search(dec) else 'no',
                     'original_guess': orig, 'pages_count': len(e['pages']),
                     'sitewide': 'yes' if n200 and len(e['pages']) >= 0.8 * n200 else 'no',
                     'sources': '; '.join(e['sources']), 'pages': ' | '.join(e['pages']), 'url_encoded': u})
    rows.sort(key=lambda x: (-x['pages_count'], x['image_url']))
    cols = ['image_url', 'ext', 'pages_count', 'sitewide', 'is_size_variant', 'original_guess', 'sources', 'pages', 'url_encoded']
    with open(HERE / 'images.csv', 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for row in rows:
            w.writerow(row)
    return rows


def write_search_console_csv(crawl, recs):
    by_url = {r['url']: r for r in recs}
    rows = []
    for u, sc in crawl.sc.items():
        r = by_url.get(u)
        status = r['status'] if r else ('noise: ' + sc['noise_reason'] if sc.get('noise_reason') else 'not fetched')
        final = (r.get('final_url_decoded') or '') if r else ''
        fstat = (r.get('final_status') if r and r.get('final_url') else (r['status'] if r else ''))
        rows.append({'url': decode(u), 'clicks': int(sc['clicks']), 'impressions': int(sc['impressions']),
                     'position': sc['position'] if sc['position'] is not None else '',
                     'coverage': '; '.join(sc['coverage']), 'live_status': status, 'final_url': final, 'final_status': fstat,
                     'type': r['type'] if r else '', 'lang': r['lang'] if r else '',
                     'in_sitemap': ', '.join(r['in_sitemaps']) if r and r['in_sitemaps'] else 'no',
                     'noindex': ('yes' if r.get('noindex') else 'no') if r and 'noindex' in r else '',
                     'raw_urls_in_search_console': ' | '.join(sc['raw'])})
    rows.sort(key=lambda x: (-x['clicks'], -x['impressions'], x['url']))
    cols = list(rows[0].keys()) if rows else []
    with open(HERE / 'search-console.csv', 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for row in rows:
            w.writerow(row)
    return rows


# --------------------------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------------------------

def md_table(header, rows):
    out = ['| ' + ' | '.join(header) + ' |', '| ' + ' | '.join('---' for _ in header) + ' |']
    for r in rows:
        out.append('| ' + ' | '.join(str(c).replace('|', '\\|').replace('\n', ' ') for c in r) + ' |')
    return '\n'.join(out)


def p(url):
    """Short decoded path for the report."""
    if not url:
        return ''
    d = decode(url)
    if d.startswith(ORIGIN):
        d = d[len(ORIGIN):]
    return f'`{d}`'


FINDINGS_START = '<!-- findings:start -->'
FINDINGS_END = '<!-- findings:end -->'
CUSTOM_TYPES = list(dict.fromkeys(pt['type'] for pt in POST_TYPES.values()))
SINGLE_TYPES = ['home', 'page', 'post', *CUSTOM_TYPES]
ARCHIVE_BASE = {archive_type(tax): base for tax, base in TAX_BASE.items()}  # archive type -> base path
ARCHIVE_TYPES = tuple(ARCHIVE_BASE)
TYPE_ORDER = [*SINGLE_TYPES, *ARCHIVE_TYPES, 'pagination', 'date-archive', 'author', 'other']


def bucket(st):
    if st is None:
        return 'error'
    if not isinstance(st, int):
        return str(st)
    if st == 200:
        return '200'
    if 300 <= st < 400:
        return '3xx'
    if st in (404, 410):
        return str(st)
    if 400 <= st < 500:
        return '4xx'
    if st >= 500:
        return '5xx'
    return str(st)


def eff_status(r):
    if r is None:
        return None
    if r.get('final_url'):
        return r.get('final_status')
    return r.get('status')


def short(s, n=70):
    s = s or ''
    return s if len(s) <= n else s[:n - 1] + '…'


def make_report(crawl, F, built, red_rows, vimeo_rows, image_rows, sc_rows):
    recs = built['records']
    pages = built['pages']
    by = {r['url']: r for r in recs}
    html200 = [r for r in recs if r['status'] == 200 and 'html' in (r.get('content_type') or '')]
    fetched = [F.cached(r['url']) for r in recs if F.cached(r['url'])]
    times = sorted(m['fetched_at'] for m in fetched if m.get('fetched_at'))
    L = []

    def add(*lines):
        L.extend(lines)

    def sec(title):
        L.extend(['', title, ''])

    def table(header, rows):
        L.append(md_table(header, rows))

    # keep hand-written findings across re-runs
    old = (HERE / 'REPORT.md').read_text('utf-8') if (HERE / 'REPORT.md').exists() else ''
    if FINDINGS_START in old and FINDINGS_END in old:
        findings = old[old.index(FINDINGS_START):old.index(FINDINGS_END) + len(FINDINGS_END)]
    else:
        findings = FINDINGS_START + '\n_Hand-written findings go here. Re-running the script keeps this block._\n' + FINDINGS_END

    add(f'# URL inventory: {HOST}', '',
        f"Crawled {times[0][:16].replace('T', ' ')} to {times[-1][:16].replace('T', ' ')} UTC with `inventory/crawl.py` "
        f"(read-only, about one request per second). Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC." if times else '',
        '',
        'Files in `inventory/`:', '',
        '- `urls.json`: one record per URL (status, redirect chain, type, language, head tags, H1s, embeds, forms, images, where found, Search Console numbers).',
        '- `redirects.csv`: every redirect seen, merged with `redirects.md` and the `_wp_old_slug` URLs from the export.',
        '- `vimeo.csv`: every Vimeo ID with the page it is on and the text around it.',
        '- `images.csv`: every `/wp-content/uploads/` file used by a live page.',
        '- `search-console.csv`: every URL from the Search Console exports with its live status.',
        '- `crawl.py`: the crawler. Raw responses are cached in `inventory/.cache/` (not for git).',
        '', '## Findings', '', findings)

    # ---------------------------------------------------------------- 1. counts
    sec('## 1. Counts')
    sc_all = collections.Counter(bucket(r['status']) for r in recs)
    add(f"{len(recs)} URLs recorded: " + ', '.join(f'{v} × {k}' for k, v in sorted(sc_all.items())) + '.',
        f"{len(html200)} are live HTML pages (200): " + ', '.join(f"{sum(1 for r in html200 if r['lang'] == l)} {l}" for l in LANGS)
        + f"; {sum(1 for r in html200 if not r.get('noindex'))} of them are indexable (no noindex).", '')
    cols = ['200', '3xx', '404', 'other']
    rows = []
    tot = collections.Counter()
    for t in TYPE_ORDER:
        row = [t]
        n = 0
        for lang in LANGS:
            for c in cols:
                k = sum(1 for r in recs if r['type'] == t and r['lang'] == lang and (
                    bucket(r['status']) == c if c != 'other' else bucket(r['status']) not in ('200', '3xx', '404')))
                row.append(k or '')
                tot[(lang, c)] += k
                n += k
        if n:
            rows.append(row + [n])
    rows.append(['**total**'] + [tot[(lang, c)] for lang in LANGS for c in cols] + [len(recs)])
    table(['Type', *[f'{lang.upper()} {c}' for lang in LANGS for c in cols], 'Total'], rows)
    add('', '"other" = 410, other 4xx, 5xx or network error. Type and language of a redirect or 404 come from its path.')
    others = [r for r in recs if bucket(r['status']) not in ('200', '3xx', '404')]
    if others:
        add('', 'URLs with "other" status:', '')
        for r in others:
            add(f"- {p(r['url'])}: {r['status'] or r.get('error')}")

    # discovery
    def srcs(r):
        f = r['found_in']
        return {
            'sitemap': any(s.startswith('sitemap:') for s in f),
            'sc': any(s.startswith('search-console') for s in f),
            'export': any(s.startswith(('export:', 'export-derived:')) for s in f),
            'redirects.md': any(s.startswith('redirects.md') for s in f),
            'link': r['link_from_count'] > 0 or any(s.startswith(('hreflang-from', 'canonical-from', 'rel-next')) for s in f),
            'redirect': any(s.startswith('redirect-from:') for s in f),
        }
    link_only = [r for r in html200 if (lambda s: not (s['sitemap'] or s['sc'] or s['export'] or s['redirects.md']))(srcs(r))]
    add('', 'Where the live pages were found (a page can be in several sources):', '')
    table(['Source', 'Live 200 pages'], [
        ['XML sitemaps', sum(1 for r in html200 if srcs(r)['sitemap'])],
        ['Search Console exports', sum(1 for r in html200 if srcs(r)['sc'])],
        ['WordPress export (incl. derived URLs)', sum(1 for r in html200 if srcs(r)['export'])],
        ['Internal links (incl. hreflang, canonical, next/prev)', sum(1 for r in html200 if srcs(r)['link'])],
        ['Only through internal links or redirects', len(link_only)],
    ])
    if link_only:
        add('', f"Live pages found only by following links ({len(link_only)}; " +
            ', '.join(f'{t} {n}' for t, n in collections.Counter(r['type'] for r in link_only).most_common()) + '): ' +
            ', '.join(p(r['url']) + (' (noindex)' if r.get('noindex') else '') for r in sorted(link_only, key=lambda r: r['url'])) + '.')

    # ---------------------------------------------------------------- 2. sitemaps
    sec('## 2. XML sitemaps against the live site')
    rows = []
    problems = []
    for su, locs in crawl.sitemaps.items():
        if not locs:
            continue
        name = su.rsplit('/', 1)[-1]
        urls = [normalize(l)[0] for l in locs]
        st = collections.Counter(bucket(by[u]['status']) if u in by else 'not crawled' for u in urls)
        ni = sum(1 for u in urls if u in by and by[u].get('noindex'))
        cn = sum(1 for u in urls if u in by and by[u].get('canonical_is_self') is False)
        langs = collections.Counter(by[u]['lang'] for u in urls if u in by)
        rows.append([name, len(locs), *[langs.get(l, 0) for l in LANGS],
                     ', '.join(f'{v} × {k}' for k, v in sorted(st.items())), ni, cn])
        for u in urls:
            r = by.get(u)
            if r and (r['status'] != 200 or r.get('noindex') or r.get('canonical_is_self') is False):
                why = []
                if r['status'] != 200:
                    why.append(f"{r['status']} → {p(r.get('final_url'))} ({r.get('final_status')})" if r.get('final_url') else str(r['status']))
                if r.get('noindex'):
                    why.append('noindex')
                if r.get('canonical_is_self') is False:
                    why.append('canonical → ' + p(r.get('canonical')))
                problems.append(f"- {name}: {p(u)}: {'; '.join(why)}")
    table(['Sitemap', 'URLs', *[l.upper() for l in LANGS], 'Live status', 'noindex', 'Canonical elsewhere'], rows)
    if problems:
        add('', 'Sitemap URLs that are not a plain indexable 200:', '', *problems)
    not_in = [r for r in html200 if not r['in_sitemaps'] and not r.get('noindex')]
    add('', f"**{len(not_in)} live, indexable pages are in no sitemap.** By type:", '')
    c = collections.Counter((r['type'], r['lang']) for r in not_in)
    table(['Type', *[l.upper() for l in LANGS]], [[t, *[c.get((t, l), '') for l in LANGS]] for t in TYPE_ORDER if any(c.get((t, l)) for l in LANGS)])
    listed = [r for r in not_in if r['type'] in (*SINGLE_TYPES, 'other')]
    if listed:
        add('', 'Of these, the pages, posts and other singles:', '')
        for r in sorted(listed, key=lambda r: r['url']):
            sc = r.get('search_console') or {}
            clicks = f", {sc['clicks']:.0f} clicks" if sc else ''
            add(f"- {p(r['url'])} ({r['type']}, {r['lang']}){clicks}")

    # ---------------------------------------------------------------- 3. Search Console
    sec('## 3. Search Console URLs and their live status')
    sc_imp = {u: s for u, s in crawl.sc.items() if s['impressions'] > 0}
    groups = collections.defaultdict(list)
    for u, s in sc_imp.items():
        r = by.get(u)
        if s.get('noise_reason'):
            groups['noise (query string, feed, file)'].append(u)
        elif r is None:
            groups['not crawled'].append(u)
        elif r['status'] == 200:
            groups['200' + (' noindex' if r.get('noindex') else '') + ('' if r['in_sitemaps'] else ', not in sitemap')].append(u)
        elif r.get('final_url'):
            groups[f"redirect → {bucket(r.get('final_status'))}"].append(u)
        else:
            groups[bucket(r['status'])].append(u)
    add(f"The performance export lists {sum(1 for s in crawl.sc_raw.values() if s['impressions'] > 0)} URL rows with impressions; "
        f"normalised to `{ORIGIN}` that is {len(sc_imp)} URLs.", '')
    table(['Live status today', 'URLs', 'Clicks', 'Impressions'],
          [[k, len(v), f"{sum(sc_imp[u]['clicks'] for u in v):.0f}", f"{sum(sc_imp[u]['impressions'] for u in v):.0f}"]
           for k, v in sorted(groups.items(), key=lambda kv: -len(kv[1]))])
    lost = [u for u, s in sc_imp.items() if not s.get('noise_reason') and u in by and isinstance(eff_status(by[u]), int) and eff_status(by[u]) >= 400]
    lost += [u for u, s in sc_imp.items() if not s.get('noise_reason') and u in by and eff_status(by[u]) is None]
    add('', f"### Would be lost: {len(lost)} URLs with impressions end in an error", '')
    if lost:
        table(['URL', 'Clicks', 'Impr.', 'Live', 'Final'], [[p(u), f"{sc_imp[u]['clicks']:.0f}", f"{sc_imp[u]['impressions']:.0f}", by[u]['status'],
                                                         (p(by[u].get('final_url')) + f" ({by[u].get('final_status')})") if by[u].get('final_url') else '']
                                                        for u in sorted(lost, key=lambda u: -sc_imp[u]['impressions'])])
    else:
        add('None.')
    miss = [u for u in sc_imp if u in by and by[u]['status'] == 200 and not by[u]['in_sitemaps'] and not sc_imp[u].get('noise_reason')]
    add('', f"### Live but missed by the sitemaps: {len(miss)} URLs with impressions "
            f"({sum(sc_imp[u]['clicks'] for u in miss):.0f} clicks)", '')
    c = collections.Counter((by[u]['type'], by[u]['lang']) for u in miss)
    cl = collections.Counter()
    for u in miss:
        cl[(by[u]['type'], by[u]['lang'])] += sc_imp[u]['clicks']
    table(['Type', 'Lang', 'URLs', 'Clicks', 'noindex'], [[t, l, n, f'{cl[(t, l)]:.0f}', sum(1 for u in miss if by[u]['type'] == t and by[u]['lang'] == l and by[u].get('noindex'))]
                                                        for (t, l), n in sorted(c.items(), key=lambda kv: -kv[1])])
    add('', 'The 25 with most clicks:', '')
    table(['URL', 'Type', 'Clicks', 'Impr.', 'Robots'], [[p(u), by[u]['type'], f"{sc_imp[u]['clicks']:.0f}", f"{sc_imp[u]['impressions']:.0f}",
                                                         'noindex' if by[u].get('noindex') else 'index']
                                                        for u in sorted(miss, key=lambda u: (-sc_imp[u]['clicks'], -sc_imp[u]['impressions']))[:25]])
    red = [u for u in sc_imp if u in by and by[u].get('final_url') and not sc_imp[u].get('noise_reason')]
    add('', f"### Redirecting: {len(red)} URLs with impressions redirect", '')
    if red:
        table(['URL', 'Clicks', 'Impr.', 'Hops', 'Final', 'Final status'],
              [[p(u), f"{sc_imp[u]['clicks']:.0f}", f"{sc_imp[u]['impressions']:.0f}", by[u].get('redirect_hops'), p(by[u].get('final_url')), by[u].get('final_status')]
               for u in sorted(red, key=lambda u: -sc_imp[u]['impressions'])])
    noi = [u for u in sc_imp if u in by and by[u]['status'] == 200 and by[u].get('noindex')]
    if noi:
        add('', f"### Noindex today but with impressions: {len(noi)} URLs", '')
        table(['URL', 'Type', 'Clicks', 'Impr.'], [[p(u), by[u]['type'], f"{sc_imp[u]['clicks']:.0f}", f"{sc_imp[u]['impressions']:.0f}"]
                                                 for u in sorted(noi, key=lambda u: -sc_imp[u]['impressions'])])
    noise = [u for u in sc_imp if sc_imp[u].get('noise_reason')]
    if noise:
        add('', f"Noise rows with impressions (query strings, feeds, files; not crawled): {len(noise)}, "
                f"{sum(sc_imp[u]['clicks'] for u in noise):.0f} clicks. They are listed in `search-console.csv`.")
    # coverage
    add('', '### Coverage (indexing) lists against the live site', '')
    cov = collections.defaultdict(list)
    variant = set()
    for u, s in crawl.sc.items():
        for c_ in s['coverage']:
            base_issue = c_.split(' (as ')[0]
            cov[base_issue].append(u)
            if ' (as ' in c_:
                variant.add((base_issue, u))
    rows = []
    for issue, us in sorted(cov.items(), key=lambda kv: -len(kv[1])):
        st = collections.Counter()
        for u in us:
            s = crawl.sc[u]
            if (issue, u) in variant and not any(c_ == issue for c_ in s['coverage']):
                st['http:// or bare-host variant'] += 1
            elif s.get('noise_reason'):
                st['noise'] += 1
            elif u in by:
                r = by[u]
                st[bucket(r['status']) + (f'→{bucket(r.get("final_status"))}' if r.get('final_url') else '') + (' noindex' if r.get('noindex') else '')] += 1
            else:
                st['not crawled'] += 1
        rows.append([issue, len(us), ', '.join(f'{v} × {k}' for k, v in st.most_common())])
    table(['Search Console state', 'URLs', 'Live status today'], rows)
    for issue in ('Not found (404)', 'Server error (5xx)'):
        if issue in cov:
            add('', f'"{issue}" URLs today:', '')
            for u in cov[issue]:
                r = by.get(u)
                st = crawl.sc[u].get('noise_reason') and 'noise, not crawled' or (r and (f"{r['status']}" + (f" → {p(r.get('final_url'))} ({r.get('final_status')})" if r.get('final_url') else '')))
                add(f"- {p(u)}: {st}")
    idx = cov.get('Indexed', [])
    bad_idx = [u for u in idx if u in by and (eff_status(by[u]) != 200 or by[u].get('noindex'))]
    if bad_idx:
        add('', f'Indexed URLs that no longer answer as an indexable 200 ({len(bad_idx)}):', '')
        for u in bad_idx:
            r = by[u]
            add(f"- {p(u)}: {r['status']}" + (f" → {p(r.get('final_url'))} ({r.get('final_status')})" if r.get('final_url') else '') + (' noindex' if r.get('noindex') else ''))

    # ---------------------------------------------------------------- 4. translation pairs
    sec('## 4. Translation pairs (hreflang)')
    rows = []
    unpaired = collections.defaultdict(list)
    hl_problems = []
    for t in [t for t in TYPE_ORDER if t not in ('tag', 'pagination', 'date-archive', 'author')]:
        for lang in LANGS:
            rs = [r for r in html200 if r['type'] == t and r['lang'] == lang]
            if not rs:
                continue
            others = [o for o in LANGS if o != lang]
            paired = 0
            for r in rs:
                hl = r.get('hreflang') or {}
                if any(o in hl for o in others):
                    paired += 1
                else:
                    unpaired[(t, lang)].append(r)
                for other in [o for o in others if o in hl]:
                    tu = normalize(hl[other], r['url'])[0]
                    tr = by.get(tu)
                    if tr is None or tr['status'] != 200:
                        hl_problems.append(f"- {p(r['url'])} → hreflang {other} {p(tu)} is {tr['status'] if tr else 'not crawled'}")
                    elif normalize((tr.get('hreflang') or {}).get(lang, ''), tu)[0] != r['url']:
                        hl_problems.append(f"- {p(r['url'])} → {p(tu)}, which does not point back (its {lang} alternate: {p((tr.get('hreflang') or {}).get(lang))})")
                if hl and normalize(hl.get(lang, ''), r['url'])[0] != r['url']:
                    hl_problems.append(f"- {p(r['url'])}: own hreflang {lang} is {p(hl.get(lang))}")
            rows.append([t, lang, len(rs), paired, len(rs) - paired])
    table(['Type', 'Lang', 'Live pages', f'With another language', 'Without'], rows)
    add('', 'Pages without a translation (no hreflang to another language):', '')
    for (t, lang), rs in unpaired.items():
        add('', f'**{t}, {lang} only ({len(rs)}):** ' + ', '.join(p(r['url']) for r in sorted(rs, key=lambda r: r['url'])))
    if hl_problems:
        add('', 'hreflang problems:', '', *sorted(set(hl_problems)))
    else:
        add('', 'All hreflang pairs point to live pages and point back.')

    # ---------------------------------------------------------------- 5. noindex
    sec('## 5. Noindex pages')
    ni = [r for r in html200 if r.get('noindex')]
    c = collections.Counter((r['type'], r['lang']) for r in ni)
    add(f'{len(ni)} live pages carry noindex (meta robots or X-Robots-Tag).', '')
    table(['Type', *[l.upper() for l in LANGS]], [[t, *[c.get((t, l), '') for l in LANGS]] for t in TYPE_ORDER if any(c.get((t, l)) for l in LANGS)])
    add('')
    for t in TYPE_ORDER:
        rs = [r for r in ni if r['type'] == t]
        if rs:
            add(f"- **{t}**: " + ', '.join(p(r['url']) for r in sorted(rs, key=lambda r: r['url'])))
    xr = [r for r in recs if r.get('x_robots_tag')]
    if xr:
        add('', f"X-Robots-Tag headers seen on {len(xr)} URLs: " + ', '.join(sorted(set(r['x_robots_tag'] for r in xr))))

    # ---------------------------------------------------------------- 6. broken links
    sec('## 6. Internal links')
    targets = collections.defaultdict(set)
    for u, d in pages.items():
        for href, _t, _c, _m in d['links']:
            nu, reason = normalize(href, u)
            if nu and reason is None:
                targets[nu].add(u)
    broken = []
    via_redirect = []
    for tu, srcs_ in targets.items():
        r = by.get(tu)
        st = eff_status(r)
        if r is None:
            continue
        if st is None or (isinstance(st, int) and st >= 400):
            broken.append((tu, srcs_))
        elif r.get('final_url'):
            via_redirect.append((tu, srcs_))
    add(f"{len(targets)} distinct internal link targets on {len(pages)} live pages.", '')
    add(f"### Broken: {len(broken)} link targets end in an error", '')
    if broken:
        table(['Target', 'Status', 'Linked from (pages)', 'Examples'],
              [[p(tu), f"{by[tu]['status']}" + (f" → {by[tu].get('final_status')} {p(by[tu].get('final_url'))}" if by[tu].get('final_url') else ''),
                len(s), ', '.join(p(x) for x in sorted(s)[:4]) + (' …' if len(s) > 4 else '')]
               for tu, s in sorted(broken, key=lambda x: -len(x[1]))])
    add('', f"### Links that go through a redirect: {len(via_redirect)} targets", '',
        'These links should point at the final URL on the new site.', '')
    archive_links = [(tu, s) for tu, s in via_redirect if by[tu]['type'] in ('date-archive', 'author')]
    other_links = [(tu, s) for tu, s in via_redirect if by[tu]['type'] not in ('date-archive', 'author')]
    if other_links:
        table(['Target', 'Final', 'Hops', 'Linked from (pages)', 'Examples'],
              [[p(tu), p(by[tu].get('final_url')) + f" ({by[tu].get('final_status')})", by[tu].get('redirect_hops'), len(s),
                ', '.join(p(x) for x in sorted(s)[:3]) + (' …' if len(s) > 3 else '')]
               for tu, s in sorted(other_links, key=lambda x: -len(x[1]))])
    if archive_links:
        add('', f"Plus {len(archive_links)} date and author archive links (post bylines and dates, "
                f"{len({x for tu, s in archive_links for x in s})} pages), which redirect: "
                + ', '.join(p(tu) for tu, s in sorted(archive_links)) + '.')

    # ---------------------------------------------------------------- 7. redirects
    sec('## 7. Redirects')
    rr = [r for r in recs if r['status'] and 300 <= r['status'] < 400]
    add(f"{len(rr)} URLs redirect. Status codes: " + ', '.join(f'{v} × {k}' for k, v in collections.Counter(r['status'] for r in rr).most_common()) + '.',
        'Sent by (X-Redirect-By header): ' + ', '.join(f"{v} × {k or 'no header'}" for k, v in collections.Counter(r.get('redirect_by') or '' for r in rr).most_common()) + '.', '')
    chains = [r for r in rr if (r.get('redirect_hops') or 0) > 1]
    add(f"**Chains (more than one hop): {len(chains)}**", '')
    for r in sorted(chains, key=lambda r: r['url']):
        add('- ' + ' → '.join(f"{p(u)} ({s})" for u, s in r['redirect_chain']))
    to404 = [r for r in rr if isinstance(r.get('final_status'), int) and r['final_status'] >= 400]
    add('', f"**Redirects that end in an error: {len(to404)}**", '')
    for r in to404:
        add('- ' + ' → '.join(f"{p(u)} ({s})" for u, s in r['redirect_chain']))
    notes = [r for r in rr if r.get('redirect_notes')]
    if notes:
        add('', 'Redirect notes:', '')
        for r in notes:
            add(f"- {p(r['url'])}: {'; '.join(r['redirect_notes'])}")
    mism = [row for row in red_rows.values() if row['matches_expected'] == 'no']
    add('', f"**Rows in redirects.md or `_wp_old_slug` whose live behaviour differs from the expected target: {len(mism)}**", '')
    for row in mism:
        add(f"- `{row['from_decoded'].replace(ORIGIN, '')}`: expected `{row['expected_target']}`, live {row['status']}"
            + (f" → `{row['final_url'].replace(ORIGIN, '')}` ({row['final_status']})" if row['final_url'] else '') + f" [{'; '.join(dict.fromkeys(row['source']))}]")

    # ---------------------------------------------------------------- 8. video sitemap
    sec('## 8. Video sitemap')
    # video sitemap cross-check
    vs_rows = []
    id_pages = collections.defaultdict(set)
    id_title = {}
    for u, vs in crawl.video_sitemap.items():
        r = by.get(u)
        page_ids = set()
        if r and r.get('embeds'):
            page_ids = {('youtube', i) for i in r['embeds']['youtube_ids']} | {('vimeo', i) for i in r['embeds']['vimeo_ids']}
        for v in vs:
            prov, vid = video_id(v.get('player_loc') or v.get('content_loc'))
            id_pages[(prov, vid)].add(u)
            id_title[(prov, vid)] = v.get('title')
            vs_rows.append((u, v, prov, vid, (prov, vid) in page_ids, page_ids, r))
    match = sum(1 for x in vs_rows if x[4])
    vs_pages = len(crawl.video_sitemap)
    add('', f"**Video sitemap cross-check.** The video sitemaps have {len(vs_rows)} video entries on {vs_pages} URLs. "
            f"{match} entries name a video that the page really embeds; {len(vs_rows) - match} name a video that is not on the page.", '')
    reused = [(k, us) for k, us in id_pages.items() if len(us) > 1]
    if reused:
        add('Video IDs that the sitemap attaches to more than one URL:', '')
        for (prov, vid), us in sorted(reused, key=lambda x: -len(x[1]))[:10]:
            add(f"- {prov} `{vid}` \"{short(id_title.get((prov, vid)), 60)}\": {len(us)} URLs")
        if len(reused) > 10:
            add(f"- … and {len(reused) - 10} more IDs on 2 to {max(len(us) for k, us in sorted(reused, key=lambda x: -len(x[1]))[10:])} URLs each")
    add('', '<details><summary>Entries whose video is not on the page</summary>', '')
    table(['URL', 'Sitemap video', 'Sitemap title', 'Videos on the page'],
          [[p(u), f'{prov} {vid}', short(v.get('title'), 50), ', '.join(f'{a} {b}' for a, b in sorted(ids)) or 'none']
           for u, v, prov, vid, ok, ids, r in vs_rows if not ok])
    add('', '</details>')
    not_in_vs = [r for r in html200 if r['url'] not in crawl.video_sitemap and (r.get('embeds') or {}).get('vimeo_ids', []) + (r.get('embeds') or {}).get('youtube_ids', [])]
    add('', f"- Pages with a video embed but no video sitemap entry: {len(not_in_vs)}.")

    # ---------------------------------------------------------------- 9. archives
    sec('## 9. Categories and tags')
    rows = []
    for t in ARCHIVE_TYPES:
        for lang in LANGS:
            def of_archive(r):
                po = r.get('pagination_of') or ''
                return po[len(lang_prefix(po)):].startswith(ARCHIVE_BASE[t])
            rs = [r for r in recs if (r['type'] == t or (r['type'] == 'pagination' and of_archive(r))) and r['lang'] == lang]
            if not rs:
                continue
            live = [r for r in rs if r['status'] == 200]
            rows.append([t, lang, len(rs), len(live), sum(1 for r in live if not r.get('noindex')), sum(1 for r in live if r.get('noindex')),
                         sum(1 for r in rs if r['status'] and 300 <= r['status'] < 400), sum(1 for r in rs if r['status'] == 404),
                         f"{sum((r.get('search_console') or {}).get('clicks', 0) for r in rs):.0f}",
                         f"{sum((r.get('search_console') or {}).get('impressions', 0) for r in rs):.0f}"])
    table(['Archive', 'Lang', 'URLs', 'Live', 'Index', 'Noindex', 'Redirect', '404', 'Clicks', 'Impr.'], rows)
    add('', 'Counts include the `/page/N/` pages of each archive.', '')
    for t in [t for t in ARCHIVE_TYPES if not t.endswith('tag')]:
        rs = sorted([r for r in recs if r['type'] == t], key=lambda r: r['url'])
        add(f'**{t}**:', '')
        table(['URL', 'Status', 'Robots', 'Clicks', 'Impr.', 'Found via'],
              [[p(r['url']), r['status'] if not r.get('final_url') else f"{r['status']} → {p(r.get('final_url'))} ({r.get('final_status')})",
                'noindex' if r.get('noindex') else ('index' if r['status'] == 200 else ''),
                f"{(r.get('search_console') or {}).get('clicks', 0):.0f}", f"{(r.get('search_console') or {}).get('impressions', 0):.0f}",
                'links' if r['link_from_count'] else ', '.join(sorted({s.split(':')[0] for s in r['found_in']}))]
               for r in rs])
        add('')
    for t in [t for t in ARCHIVE_TYPES if t.endswith('tag')]:
        rs = [r for r in recs if r['type'] == t and r['status'] == 200]
        langs = collections.Counter((r['lang'], 'noindex' if r.get('noindex') else 'index') for r in rs)
        with_sc = [r for r in rs if (r.get('search_console') or {}).get('impressions')]
        add(f"**{t}** live ({len(rs)}): " + ', '.join(f'{l} {i} {n}' for (l, i), n in sorted(langs.items())) +
            f". {len(with_sc)} have Search Console impressions ({sum(r['search_console']['clicks'] for r in with_sc):.0f} clicks, "
            f"{sum(r['search_console']['impressions'] for r in with_sc):.0f} impressions).", '')

    # ---------------------------------------------------------------- 10. forms, maps, iframes, videos
    sec('## 10. Forms, maps, iframes and video embeds')
    n_pages = len(html200)
    fg = collections.defaultdict(list)
    for r in html200:
        for f in (r.get('embeds') or {}).get('forms', []):
            fg[(f['plugin'], f['form_id'] or f['html_id'])].append((r, f))
    add('**Forms** (search forms left out):', '')
    rows = []
    for (plugin, fid), lst in sorted(fg.items(), key=lambda kv: -len(kv[1])):
        f0 = lst[0][1]
        main = sum(1 for r, f in lst if f.get('in_main'))
        rows.append([plugin, fid, len(lst), main, '; '.join(x for x in [', '.join(dict.fromkeys(f0['labels'])), 'fields: ' + ', '.join(f0['fields'])] if x),
                     'yes' if any(f['file_upload'] for r, f in lst) else 'no',
                     ', '.join(p(r['url']) for r, f in lst[:6]) + (' …' if len(lst) > 6 else '')])
    table(['Plugin', 'Form id', 'Pages', 'In main content', 'Labels and field names', 'File upload', 'Pages (first 6)'], rows)
    iframes = [(r, i) for r in html200 for i in (r.get('embeds') or {}).get('iframes', [])]
    add('', f"**Iframes from other hosts** ({len(iframes)} on {len({r['url'] for r, i in iframes})} pages):", '')
    if iframes:
        table(['Page', 'Host', 'src', 'Title'], [[p(r['url']), i['host'], short(i['src'], 70), short(i['title'], 30)] for r, i in iframes])
    maps = [(r, m) for r in html200 for m in (r.get('embeds') or {}).get('maps', [])]
    add('', f"**Google Maps embeds**: {len(maps)} on {len({r['url'] for r, m in maps})} pages" + (f" ({n_pages} live pages in total)" if maps else '') + '.', '')
    if maps:
        mg = collections.defaultdict(list)
        for r, m in maps:
            mg[m['src'][:120]].append(r)
        for src, rs in mg.items():
            add(f"- `{short(src, 110)}`: {len(rs)} pages: " + ', '.join(p(r['url']) for r in rs[:12]) + (' …' if len(rs) > 12 else ''))
    yt_pages = [r for r in html200 if (r.get('embeds') or {}).get('youtube_ids')]
    vm_pages = [r for r in html200 if (r.get('embeds') or {}).get('vimeo_ids')]
    yt_ids = {i for r in yt_pages for i in r['embeds']['youtube_ids']}
    vm_ids = {i for r in vm_pages for i in r['embeds']['vimeo_ids']}
    add('', f"**Video embeds**: YouTube on {len(yt_pages)} pages ({len(yt_ids)} distinct IDs); Vimeo on {len(vm_pages)} pages ({len(vm_ids)} distinct IDs). "
            f"Every Vimeo ID with its pages and surrounding text is in `vimeo.csv` ({len(vimeo_rows)} rows).", '')
    c = collections.Counter()
    for r in vm_pages:
        c[(r['type'], r['lang'])] += 1
    add('Pages with Vimeo, by type: ' + ', '.join(f'{t} {l}: {n}' for (t, l), n in c.most_common()) + '.')
    meta_only = {row['vimeo_id'] for row in vimeo_rows if row['occurrences_on_page'] == 0} - vm_ids
    if meta_only:
        add('', f"{len(meta_only)} more Vimeo IDs appear only in og:video tags, JSON-LD or the video sitemap, never in a player on the page.")
    top = sorted(vm_pages, key=lambda r: -len(r['embeds']['vimeo_ids']))[:12]
    add('', 'Pages with the most Vimeo videos: ' + ', '.join(f"{p(r['url'])} ({len(r['embeds']['vimeo_ids'])})" for r in top) + '.')
    vid_pages = sorted({r['url']: r for r in yt_pages + vm_pages}.values(), key=lambda r: (r['type'], r['url']))
    add('', f'<details><summary>All {len(vid_pages)} pages with a YouTube or Vimeo player</summary>', '')
    table(['Page', 'Type', 'YouTube', 'Vimeo'],
          [[p(r['url']), r['type'], ' '.join(r['embeds']['youtube_ids']), ' '.join(r['embeds']['vimeo_ids'])] for r in vid_pages])
    add('', '</details>')

    # ---------------------------------------------------------------- 11. images
    sec('## 11. Images')
    n_img = len(image_rows)
    originals = {row['original_guess'] for row in image_rows}
    sources = collections.Counter()
    for row in image_rows:
        for s in row['sources'].split('; '):
            sources[s] += 1
    sitewide = [row for row in image_rows if row['sitewide'] == 'yes']
    exp_att = sum(1 for it in crawl.export['items'] if it['type'] == 'attachment')
    other_up = collections.defaultdict(set)
    for r in html200:
        for o in r.get('uploads_other', []):
            other_up[o['url']].add(r['url'])
    add(f"- **{n_img} distinct image files** under `/wp-content/uploads/` are referenced by the {n_pages} live pages "
        f"({sum(1 for r in image_rows if r['is_size_variant'] == 'yes')} of them are WordPress size variants such as `-1024x576`).",
        f"- They come from {len(originals)} distinct originals (size suffix removed). The export holds {exp_att} media items.",
        f"- Against Cloudflare's 20,000-file limit: {n_img} files if the same files are kept, about {len(originals)} if only one size per image is kept. "
        f"Plus the site's own HTML pages ({n_pages}) and assets.",
        f"- {len(sitewide)} images are on at least 80 % of pages (logo, favicons, footer).",
        '- How they are referenced: ' + ', '.join(f'{k} {v}' for k, v in sources.most_common()) + '.',
        f"- Background images from Elementor's per-page CSS files: {sum(1 for row in image_rows if 'elementor-css' in row['sources'])} files "
        f"({sum(1 for row in image_rows if row['sources'] == 'elementor-css')} found only there).")
    if other_up:
        add(f"- Other uploads linked or embedded (PDF, video, documents): {len(other_up)}: " + ', '.join(f"`{decode(u).replace(ORIGIN, '')}`" for u in sorted(other_up)))

    # ---------------------------------------------------------------- 12. head checks
    sec('## 12. Titles, descriptions, canonicals, H1 and social tags')
    idx_pages = [r for r in html200 if not r.get('noindex')]
    no_title = [r for r in html200 if not r.get('title')]
    no_desc = [r for r in idx_pages if not r.get('meta_description')]
    multi = [r for r in html200 if r.get('titles_all') or r.get('meta_descriptions_all') or r.get('canonicals_all') or r.get('robots_all')]
    can_other = [r for r in html200 if r.get('canonical_is_self') is False]
    no_can = [r for r in html200 if not r.get('canonical')]
    tdup = collections.defaultdict(list)
    for r in idx_pages:
        if r.get('title'):
            tdup[r['title']].append(r)
    tdup = {k: v for k, v in tdup.items() if len(v) > 1}
    no_h1 = [r for r in html200 if not r.get('h1')]
    multi_h1 = [r for r in html200 if len(r.get('h1') or []) > 1]
    h1_generic = [r for r in html200 if set(r.get('h1') or []) & set(SITE_NAMES)]
    def by_type(rs):
        return ', '.join(f'{t} {l} {n}' for (t, l), n in collections.Counter((r['type'], r['lang']) for r in rs).most_common())
    singles_no_desc = [r for r in no_desc if r['type'] in (*SINGLE_TYPES, 'other')]
    add(f"- No `<title>`: {len(no_title)}.",
        f"- Indexable pages without a meta description: {len(no_desc)} ({by_type(no_desc)})."
        + (' The pages, posts and other singles among them: ' + ', '.join(p(r['url']) for r in singles_no_desc) + '.' if singles_no_desc else ''),
        f"- Pages with more than one title, description, canonical or robots tag: {len(multi)}" + (': ' + ', '.join(p(r['url']) for r in multi[:15]) if multi else '') + '.',
        f"- No canonical: {len(no_can)} ({by_type(no_can)}); all of them are noindex: {'yes' if all(r.get('noindex') for r in no_can) else 'no'}.",
        f"- Canonical pointing to another URL: {len(can_other)}" + (': ' + '; '.join(f"{p(r['url'])} → {p(r['canonical'])}" for r in can_other[:20]) if can_other else '') + '.',
        f"- Titles shared by several indexable pages: {len(tdup)} titles" + (': ' + '; '.join(f'"{short(k, 50)}" × {len(v)}' for k, v in sorted(tdup.items(), key=lambda kv: -len(kv[1]))[:8]) if tdup else '') + '. Often an archive and its `/page/N/` pages, or two language versions with the same title.',
        f"- No H1: {len(no_h1)}" + (': ' + ', '.join(p(r['url']) for r in no_h1) if no_h1 else '') + '.',
        f"- More than one H1: {len(multi_h1)}" + (': ' + '; '.join(f"{p(r['url'])} ({' / '.join(short(h, 40) for h in r['h1'])})" for r in multi_h1) if multi_h1 else '') + '.',
        f"- H1 is the site name ({' / '.join(SITE_NAMES) or 'oldSite.siteNames not set'}): {len(h1_generic)} pages ({by_type(h1_generic)}).")
    ic = collections.Counter()
    for r in html200:
        for i in r.get('social_tag_issues', []):
            key = re.sub(r'(conflict|duplicated|empty value|malformed).*', r'\1', i, flags=re.S)
            ic[key] += 1
    add('', 'Open Graph and Twitter tag issues (pages affected):', '')
    for k, v in ic.most_common():
        add(f'- {k}: {v}')
    ver = collections.Counter()
    for r in html200:
        for k, vals in (r.get('verification') or {}).items():
            for v in vals:
                ver[f'{k}: {v}'] += 1
    if ver:
        add('', 'Verification meta tags: ' + '; '.join(f'`{k}` on {v} pages' for k, v in ver.items()) + '.')

    # ---------------------------------------------------------------- 13. export cross-check
    sec('## 13. WordPress export against the live site')
    rows = []
    bad_items = []
    for t in ('page', 'post', *POST_TYPES):
        its = [it for it in crawl.export['items'] if it['type'] == t and it['status'] == 'publish']
        st = collections.Counter()
        for it in its:
            u = normalize(it['link'])[0]
            r = by.get(u)
            b = bucket(r['status']) if r else 'not crawled'
            if r and r.get('final_url'):
                b += '→' + bucket(r.get('final_status'))
            if r and r['status'] == 200 and r.get('noindex'):
                b += ' noindex'
            st[b] += 1
            if not r or r['status'] != 200:
                bad_items.append((t, it, r))
        rows.append([t, len(its), ', '.join(f'{v} × {k}' for k, v in st.most_common())])
    table(['Post type', 'Published', 'Live status of their URLs'], rows)
    if bad_items:
        add('', 'Published items whose URL is not a 200:', '')
        for t, it, r in bad_items:
            add(f"- {t} {it['id']} \"{short(it['title'], 50)}\" {p(normalize(it['link'])[0])}: " + (
                f"{r['status']}" + (f" → {p(r.get('final_url'))} ({r.get('final_status')})" if r.get('final_url') else '') if r else 'not crawled'))
    exp_urls = set(crawl.export_by_url)
    singles = [r for r in html200 if r['type'] in SINGLE_TYPES and r['url'] not in exp_urls]
    if singles:
        add('', f"Live singles with no item in the export: {len(singles)}: " + ', '.join(p(r['url']) for r in singles[:40]) + (' …' if len(singles) > 40 else ''))
    att = [r for r in recs if 'export:attachment-page-sample' in r['found_in']]
    if att:
        add('', 'Attachment pages (sample of 6 from the export): ' + '; '.join(
            f"{p(r['url'])} {r['status']}" + (f" → {p(r.get('final_url'))} ({r.get('final_status')})" if r.get('final_url') else '') for r in att) + '.')

    # ---------------------------------------------------------------- 14. noise
    sec('## 14. Noise that was skipped')
    c = collections.Counter(v['reason'] for v in crawl.noise.values())
    add('Internal URLs seen in links or Search Console but not crawled: ' + ', '.join(f'{v} × {k}' for k, v in c.most_common()) + '.')
    ex = [u for u, v in crawl.noise.items() if v['reason'] == 'query'][:15]
    if ex:
        add('', 'Query-string examples: ' + ', '.join(f'`{short(decode(u).replace(ORIGIN, ""), 70)}`' for u in ex))

    # ---------------------------------------------------------------- appendix
    sec('## Appendix: every Search Console URL with impressions')
    add('Flags: **LOST** = ends in an error today; **NO-SITEMAP** = live and indexable but in no sitemap; **REDIRECT**; **NOINDEX**; **NOISE** = query string or file, not crawled.', '')
    add('<details><summary>' + f'{len(sc_imp)} URLs, by clicks' + '</summary>', '')
    rows = []
    for u, s in sorted(sc_imp.items(), key=lambda kv: (-kv[1]['clicks'], -kv[1]['impressions'], kv[0])):
        r = by.get(u)
        flags = []
        if s.get('noise_reason'):
            flags.append('NOISE')
            live = ''
        elif r is None:
            live = 'not crawled'
        else:
            live = str(r['status'])
            if r.get('final_url'):
                live += f" → {r.get('final_status')}"
                flags.append('REDIRECT')
            es = eff_status(r)
            if es is None or (isinstance(es, int) and es >= 400):
                flags.append('LOST')
            if r['status'] == 200 and not r['in_sitemaps'] and not r.get('noindex'):
                flags.append('NO-SITEMAP')
            if r.get('noindex'):
                flags.append('NOINDEX')
        rows.append([f"`{short(decode(u).replace(ORIGIN, ''), 90)}`", f"{s['clicks']:.0f}", f"{s['impressions']:.0f}", live,
                     p(r.get('final_url')) if r and r.get('final_url') else '', ' '.join(flags)])
    table(['URL', 'Clicks', 'Impr.', 'Live', 'Final', 'Flags'], rows)
    add('', '</details>', '')
    return '\n'.join(L)


def write_report(crawl, F, built, red_rows, vimeo_rows, image_rows, sc_rows):
    text = make_report(crawl, F, built, red_rows, vimeo_rows, image_rows, sc_rows)
    (HERE / 'REPORT.md').write_text(text, 'utf-8')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--offline', action='store_true', help='use the cache only, no network requests')
    ap.add_argument('--max-requests', type=int, default=None, help='stop fetching after N network requests')
    ap.add_argument('--delay', type=float, default=1.1, help='seconds between requests (default 1.1)')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--no-outputs', action='store_true', help='crawl only, do not write output files')
    args = ap.parse_args()
    F = Fetcher(offline=args.offline, max_requests=args.max_requests, delay=args.delay, verbose=not args.quiet)
    crawl = Crawl(F)
    t0 = time.time()
    crawl.run()
    print(f'crawl done: {len(crawl.found)} URLs, {F.requests} network requests, {time.time() - t0:.0f}s',
          file=sys.stderr)
    if args.no_outputs:
        return
    built = build(crawl, F)
    recs = built['records']
    write_urls_json(recs)
    red_rows = write_redirects_csv(crawl, F, recs)
    vimeo_rows = write_vimeo_csv(crawl, recs)
    image_rows = write_images_csv(recs)
    sc_rows = write_search_console_csv(crawl, recs)
    write_report(crawl, F, built, red_rows, vimeo_rows, image_rows, sc_rows)
    print('outputs written to', HERE, file=sys.stderr)


if __name__ == '__main__':
    main()
