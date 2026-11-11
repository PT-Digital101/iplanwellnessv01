// Small helpers shared by the post-build steps: CSV, HTML attributes and text, URL paths, files.
import fs from 'node:fs';
import path from 'node:path';

/** Parses a CSV file (RFC 4180 quoting) into objects keyed by the header row. */
export function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((v) => v !== ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const escapeXml = escapeHtml;

/** Every <name ...> start tag in the HTML, as attribute maps (values decoded; bare attributes are ''). */
export function tags(html, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'gi');
  for (const m of html.matchAll(re)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    out.push(attrs);
  }
  return out;
}

/** Plain text of an HTML fragment, whitespace collapsed. */
export function textOf(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Percent-decodes a path segment by segment; malformed escapes stay as they are. */
export function decodePath(p) {
  return p
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

/** Encodes a decoded path the way browsers send it (non-ASCII as UTF-8, uppercase hex). */
export function encodePath(p) {
  return encodeURI(p);
}

export const lowerHex = (s) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

export const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

/** Decoded path of a URL on the site, or null for another host. */
export function sitePath(url, site) {
  try {
    const u = new URL(url, site);
    if (u.host !== new URL(site).host) return null;
    return decodePath(u.pathname);
  } catch {
    return null;
  }
}

/** All files under dir (relative paths with forward slashes). */
export function walk(dir, skip = () => false, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (skip(rel, entry)) continue;
    if (entry.isDirectory()) walk(full, skip, base, out);
    else out.push(rel);
  }
  return out;
}

export function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Per-site settings of the migration tools: migration.config.json at the repo root (docs/MIGRATION.md). */
export function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'migration.config.json'), 'utf8'));
}

/** Locale of a path: the first segment when it is a prefixed locale, otherwise the default locale. */
export function localeOf(p, locales) {
  const seg = p.split('/')[1];
  return locales.prefixed.includes(seg) ? seg : locales.default;
}

/** The path without its locale prefix (/en/about/ -> /about/). */
export function stripLocale(p, locales) {
  const seg = p.split('/')[1];
  return locales.prefixed.includes(seg) ? p.slice(seg.length + 1) : p;
}
