// Generates on-brand WebP placeholders for every image in src/data/images.json
// (entries with a "label") and every blog post heroImage that does not exist yet.
// Existing files are never overwritten, so real photos are safe.
//   npm run images:placeholders
import { readFile, readdir, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMG_DIR = path.join(ROOT, 'src/assets/images');
const registry = JSON.parse(await readFile(path.join(ROOT, 'src/data/images.json'), 'utf8'));

const jobs = Object.entries(registry)
	.filter(([key, v]) => !key.startsWith('_') && v.label)
	.map(([, v]) => ({ src: v.src, width: v.width, height: v.height, label: v.label }));

const blogDir = path.join(ROOT, 'src/content/blog');
for (const f of await readdir(blogDir)) {
	const md = await readFile(path.join(blogDir, f), 'utf8');
	const src = md.match(/^heroImage:\s*"?([^"\n]+)"?/m)?.[1];
	const title = md.match(/^title:\s*"?([^"\n]+)"?/m)?.[1] ?? f;
	if (src) jobs.push({ src, width: 1200, height: 675, label: `Blog · ${f.replace(/\.mdx?$/, '')}` , title });
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function svg({ width: w, height: h, label }) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <pattern id="s" width="36" height="36" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="36" height="36" fill="#335248"/><rect width="18" height="36" fill="#2d4a40"/>
    </pattern>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#11221F" stop-opacity="0.05"/><stop offset="1" stop-color="#11221F" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#s)"/>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <text x="${w - 32}" y="${h - 32}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(Math.max(13, w / 80))}" letter-spacing="2" fill="#E2D9C6">[ ${esc(label.toUpperCase())} ]</text>
</svg>`;
}

let made = 0;
for (const job of jobs) {
	const out = path.join(IMG_DIR, job.src);
	if (!out.endsWith('.webp')) throw new Error(`Image must be .webp: ${job.src}`);
	try {
		await access(out);
		continue; // keep existing (real) image
	} catch {}
	await mkdir(path.dirname(out), { recursive: true });
	await sharp(Buffer.from(svg(job))).webp({ quality: 70 }).toFile(out);
	made++;
	console.log('placeholder →', path.relative(ROOT, out));
}
console.log(`${made} placeholder(s) created, ${jobs.length - made} existing kept.`);
