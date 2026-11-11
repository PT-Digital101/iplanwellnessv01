// <lastmod> for the XML sitemap: the WordPress "last modified" date for migrated content
// (inventory/wp-modified.csv, from the export), otherwise the date of the last git commit of the page's source.
// Never the build date.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readCsv, walk } from './util.mjs';

/**
 * @param {object} o
 * @param {string} o.root
 * @param {{entrypoint: string, patternRegex: RegExp, isPrerendered?: boolean}[]} o.routes from astro:routes:resolved
 * @param {string|null} [o.editsAfter] ISO date; a git commit after it beats the WordPress date (edits after the switch)
 * @param {(message: string) => void} [o.log]
 */
export function lastmodResolver({ root, routes, editsAfter = null, log = () => {} }) {
  const wp = new Map();
  const wpFile = path.join(root, 'inventory', 'wp-modified.csv');
  if (fs.existsSync(wpFile)) for (const r of readCsv(wpFile)) wp.set(r.path, r.modified);

  const gitDates = readGitDates(root, log);
  const contentByPath = contentFiles(root);
  const importCache = new Map();

  const sourcesFor = (pagePath) => {
    const content = contentByPath.get(pagePath);
    if (content) return [content];
    const route = routes.find((r) => r.patternRegex.test(pagePath) || r.patternRegex.test(encodeURI(pagePath)));
    if (!route) return [];
    const entry = route.entrypoint;
    if (!importCache.has(entry)) importCache.set(entry, [entry, ...dataImports(root, entry)]);
    return importCache.get(entry);
  };

  return (pagePath) => {
    const sources = sourcesFor(pagePath);
    const git = sources.map((f) => gitDates.get(f)).filter(Boolean).sort().at(-1);
    const fromWp = wp.get(pagePath);
    if (fromWp && !(git && editsAfter && git > editsAfter)) return { date: fromWp, from: 'wordpress' };
    if (git) return { date: git, from: 'git', sources };
    return { date: undefined, from: 'none', sources };
  };
}

/** Last commit date (ISO, committer) per file under src/, from one git log pass. Empty without git history. */
function readGitDates(root, log) {
  const dates = new Map();
  try {
    if (!fullHistory(root, log)) return dates;
    const out = execFileSync('git', ['log', '--format=%x00%cI', '--name-only', '--', 'src'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const chunk of out.split('\0')) {
      const [date, ...names] = chunk.trim().split('\n');
      if (!date) continue;
      for (const n of names) {
        // git quotes non-ASCII paths ("src/pages/th/\340\270...") unless core.quotePath is off.
        const name = n.startsWith('"') ? unquoteGit(n) : n;
        if (name && !dates.has(name)) dates.set(name, normalizeDate(date));
      }
    }
  } catch {
    /* no git: no lastmod from git */
  }
  return dates;
}

/**
 * Cloudflare's build clones only the latest commit. In such a shallow clone every file's last commit is that one,
 * so every page would get its date. Fetch the history first; if that fails, give no git dates
 * at all rather than wrong ones. Throws without git, like the git log call.
 */
function fullHistory(root, log) {
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (shallow.trim() !== 'true') return true;
  try {
    execFileSync('git', ['fetch', '--unshallow', '--quiet'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 180_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    log('Shallow git clone: fetched the full history for the sitemap dates.');
    return true;
  } catch (e) {
    log(`Shallow git clone and the history could not be fetched (${String(e.stderr || e.message).trim().split('\n')[0]}): pages without a WordPress date get no <lastmod>.`);
    return false;
  }
}

function unquoteGit(s) {
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      const oct = body.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 3;
      } else {
        const map = { n: 10, t: 9, '"': 34, '\\': 92 };
        bytes.push(map[body[i + 1]] ?? body.charCodeAt(i + 1));
        i += 1;
      }
    } else bytes.push(...Buffer.from(body[i]));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 2026-10-04T16:03:18+07:00 -> 2026-10-04T09:03:18+00:00 (one time zone across the sitemap). */
function normalizeDate(d) {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : t.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** Content entries that name their URL in the frontmatter (path: /my-post/). */
function contentFiles(root) {
  const map = new Map();
  const dir = path.join(root, 'src', 'content');
  if (!fs.existsSync(dir)) return map;
  for (const rel of walk(dir)) {
    if (!/\.(md|mdx|markdown|ya?ml|json)$/.test(rel)) continue;
    const text = fs.readFileSync(path.join(dir, rel), 'utf8').slice(0, 4000);
    const m = text.match(/^\s*"?path"?\s*:\s*["']?([^"'\n]+?)["']?\s*,?\s*$/m);
    if (m) map.set(m[1].trim(), `src/content/${rel}`);
  }
  return map;
}

/** Files under src/data/ that a page module imports directly (its text and data). */
function dataImports(root, entry) {
  const file = path.join(root, entry);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/import\s[^'"]*['"]([^'"]+)['"]/g)) {
    if (!m[1].startsWith('.') || !m[1].includes('/data/')) continue;
    const base = path.resolve(path.dirname(file), m[1]);
    for (const cand of [base, `${base}.ts`, `${base}.js`, `${base}.json`, `${base}.mjs`]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        out.push(path.relative(root, cand).split(path.sep).join('/'));
        break;
      }
    }
  }
  return out;
}
