// Old image addresses: the originals of the images the new site uses are
// also served at their WordPress paths, /wp-content/uploads/<year>/<month>/<file>, so image search results and
// links from other sites keep working.
//
// An image in src/assets/ is "in use" when the build emitted it to dist/_astro/. Its old address comes from a
// sources.json in its folder (file -> upload URL, e.g. src/assets/blog/sources.json) or from its file name
// in inventory/images.csv (every image the old pages show). WordPress size variants (-1024x576) are only written
// when Search Console shows impressions for them (inventory/search-console.csv); they are resized from the original.
// When the site's copy has another format than the old address (.jpg for a .webp upload), it is converted.
// Renamed files need their sources.json entries written by hand. Without inventory/images.csv or src/assets/,
// nothing is copied.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { readCsv, walk } from './util.mjs';

const IMAGE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;
const UPLOADS = '/wp-content/uploads/';
const SIZE_SUFFIX = /-(\d+)x(\d+)(?=\.\w+$)/;

const sameType = (a, b) => {
  const norm = (f) => path.extname(f).toLowerCase().replace('.jpeg', '.jpg');
  return norm(a) === norm(b);
};

/** Upload path (2018/10/foo.jpg) of a live image URL, or null. */
function uploadPath(url) {
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    return p.startsWith(UPLOADS) ? p.slice(UPLOADS.length) : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {string} o.root
 * @param {string} o.distDir
 * @param {Map<string, Set<string>>} o.emitted sha1 of a source image -> emitted file names in _astro/ (Vite plugin)
 */
export async function copyOldImages({ root, distDir, emitted }) {
  const plan = planOldImages({ root, distDir, emitted });
  const { copies, variants } = plan;
  let bytes = 0;
  let converted = 0;
  for (const [up, file] of copies) {
    const dest = path.join(distDir, 'wp-content', 'uploads', ...up.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (sameType(up, file)) fs.copyFileSync(file, dest);
    else {
      // The site's copy has another format than the old address (a .jpg asset for a .webp upload): convert.
      await sharp(file).toFormat(formatOf(up)).toFile(dest);
      converted++;
    }
    bytes += fs.statSync(dest).size;
  }
  for (const v of variants) {
    const dest = path.join(distDir, 'wp-content', 'uploads', ...v.up.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await sharp(v.source).resize(v.width, v.height, { fit: 'cover' }).toFormat(formatOf(v.up)).toFile(dest);
    bytes += fs.statSync(dest).size;
  }
  return { ...plan, originals: copies.size, variants: variants.map((v) => v.up), converted, bytes };
}

const formatOf = (file) => ({ '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.gif': 'gif', '.avif': 'avif' })[path.extname(file).toLowerCase()] ?? 'jpeg';

/**
 * Which asset goes to which old address, without writing anything.
 * @param {object} o
 * @param {boolean} [o.all] treat every image in src/assets/ as in use
 */
export function planOldImages({ root, distDir, emitted, all = false }) {
  const assetsDir = path.join(root, 'src', 'assets');
  const assetFiles = fs.existsSync(assetsDir) ? walk(assetsDir).filter((f) => IMAGE.test(f)) : [];

  // Which assets the build emitted (= imported by a page). Without the Vite plugin's data, fall back to file names.
  const astroFiles = fs.existsSync(path.join(distDir, '_astro')) ? fs.readdirSync(path.join(distDir, '_astro')) : [];
  const astroBases = new Set(astroFiles.map((f) => f.replace(/\.[^.]+$/, '')));
  const used = new Map();
  for (const rel of assetFiles) {
    const file = path.join(assetsDir, rel);
    if (all) used.set(rel, file);
    else if (emitted && emitted.size) {
      const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
      const names = [...(emitted.get(hash) ?? [])].map((n) => path.basename(n).replace(/\.[^.]+$/, ''));
      if (names.some((base) => astroFiles.some((f) => f.startsWith(base + '.') || f.startsWith(base + '_')))) used.set(rel, file);
    } else {
      const stem = path.basename(rel).replace(/\.[^.]+$/, '');
      if ([...astroBases].some((b) => b.startsWith(stem + '.'))) used.set(rel, file);
    }
  }

  // Old addresses by file name, from every image the live pages showed: the file itself, the original it was
  // resized from (foo-1024x576.jpg -> foo.jpg), and the original next to WordPress's "-scaled" copy (both served).
  const imagesCsv = path.join(root, 'inventory', 'images.csv');
  const rows = fs.existsSync(imagesCsv) ? readCsv(imagesCsv) : [];
  const byName = new Map();
  const index = (name, hit) => {
    for (const key of new Set([name, name.toLowerCase()])) {
      const list = byName.get(key) ?? [];
      if (!list.some((h) => h.up === hit.up)) list.push(hit);
      byName.set(key, list);
    }
  };
  for (const r of rows) {
    const up = uploadPath(r.image_url);
    if (!up) continue;
    const orig = uploadPath(r.original_guess) ?? up;
    index(path.basename(up), { up, row: r });
    index(path.basename(orig), { up: orig, row: r });
    if (up.includes('-scaled.')) {
      index(path.basename(up).replace('-scaled.', '.'), { up, row: r });
      index(path.basename(up).replace('-scaled.', '.'), { up: up.replace('-scaled.', '.'), row: r });
    }
  }

  // sources.json files: { "<file relative to the folder>": "<upload URL>" | { src } | [urls] }.
  const fromSources = new Map();
  for (const rel of assetFiles.length ? walk(assetsDir).filter((f) => path.basename(f) === 'sources.json') : []) {
    const folder = path.dirname(rel);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(assetsDir, rel), 'utf8'));
    } catch {
      continue;
    }
    for (const [file, v] of Object.entries(data)) {
      const urls = [].concat(typeof v === 'object' && v && !Array.isArray(v) ? v.src : v).filter((u) => typeof u === 'string');
      const ups = urls.map(uploadPath).filter(Boolean);
      if (ups.length) fromSources.set(path.posix.join(folder === '.' ? '' : folder, file), ups);
    }
  }

  const copies = new Map(); // upload path -> asset file
  const unmatched = [];
  const ambiguous = [];
  for (const [rel, file] of used) {
    let ups = fromSources.get(rel);
    if (!ups) {
      const name = path.basename(rel);
      let hits = byName.get(name) ?? byName.get(name.toLowerCase()) ?? [];
      // Same file name in several upload folders: keep the ones shown on the page this asset belongs to
      // (asset folders are named after the page slug, e.g. src/assets/blog/<post-slug>/).
      if (new Set(hits.map((h) => path.dirname(h.up))).size > 1) {
        const slugs = rel.split('/').slice(1, -1);
        const onPage = hits.filter((h) => slugs.some((s) => h.row.pages.split(' | ').some((p) => p.split('/').includes(s))));
        if (onPage.length) hits = onPage;
      }
      if (new Set(hits.map((h) => path.dirname(h.up))).size > 1) {
        ambiguous.push({ asset: rel, candidates: [...new Set(hits.map((h) => h.up))] });
        continue;
      }
      ups = [...new Set(hits.map((h) => h.up))].filter((up) => !SIZE_SUFFIX.test(up) || path.basename(up).toLowerCase() === path.basename(rel).toLowerCase());
    }
    if (!ups.length) {
      unmatched.push(rel);
      continue;
    }
    for (const up of new Set(ups)) if (!copies.has(up) && IMAGE.test(up) && !/\.svg$/i.test(file) === !/\.svg$/i.test(up)) copies.set(up, file);
  }

  // WordPress size variants with search impressions, resized from the original we serve.
  const variants = [];
  const scRows = fs.existsSync(path.join(root, 'inventory', 'search-console.csv')) ? readCsv(path.join(root, 'inventory', 'search-console.csv')) : [];
  for (const r of scRows) {
    const up = uploadPath(r.url);
    const m = up && up.match(SIZE_SUFFIX);
    if (!m || !(Number(r.impressions) > 0) || copies.has(up)) continue;
    const orig = up.replace(SIZE_SUFFIX, '');
    const source = copies.get(orig) ?? copies.get(orig.replace(/(\.\w+)$/, '-scaled$1'));
    if (source && !/\.svg$/i.test(source)) variants.push({ up, source, width: +m[1], height: +m[2] });
  }

  const unmatchedByFolder = {};
  for (const u of unmatched) unmatchedByFolder[u.split('/')[0]] = (unmatchedByFolder[u.split('/')[0]] ?? 0) + 1;
  return {
    assets: assetFiles.length,
    used: used.size,
    matched: used.size - unmatched.length - ambiguous.length,
    copies,
    variants,
    unmatched,
    unmatchedByFolder,
    ambiguous,
    exactMatch: !!(emitted && emitted.size),
  };
}
