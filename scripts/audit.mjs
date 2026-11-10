// Post-build SEO audit over dist/. Fails (exit 1) on:
//  - any <img> without a non-empty alt, or whose src is not .webp/.svg
//  - any raster image file in dist that is not .webp (favicons/touch icons excepted)
//  - a page missing <title>, meta description, canonical, or not having exactly one <h1>
//   npm run audit   (runs after `npm run build`)
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DIST = path.resolve(import.meta.dirname, '../dist');
const ICON_OK = /(favicon|apple-touch-icon|icon-\d+)\.(png|ico)$/;

async function* walk(dir) {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

const problems = [];
let pages = 0;
let imgs = 0;
for await (const file of walk(DIST)) {
	const rel = path.relative(DIST, file);
	if (/\.(png|jpe?g|gif|avif|bmp|tiff?)$/i.test(file) && !ICON_OK.test(file)) problems.push(`non-webp image file: ${rel}`);
	if (!file.endsWith('.html')) continue;
	pages++;
	const html = await readFile(file, 'utf8');
	for (const tag of html.match(/<img\b[^>]*>/g) ?? []) {
		imgs++;
		const alt = tag.match(/\balt="([^"]*)"/)?.[1];
		const src = tag.match(/\bsrc="([^"]*)"/)?.[1] ?? '';
		if (!alt?.trim()) problems.push(`${rel}: <img> missing alt → ${src}`);
		if (!/\.(webp|svg)(\?|$)/.test(src) && !src.includes('f=webp')) problems.push(`${rel}: <img> not webp → ${src}`);
	}
	if (rel === '404.html') continue;
	if (!/<title>[^<]+<\/title>/.test(html)) problems.push(`${rel}: missing <title>`);
	if (!/<meta name="description" content="[^"]+"/.test(html)) problems.push(`${rel}: missing meta description`);
	if (!/<link rel="canonical"/.test(html)) problems.push(`${rel}: missing canonical`);
	const h1 = (html.match(/<h1\b/g) ?? []).length;
	if (h1 !== 1) problems.push(`${rel}: ${h1} <h1> elements (expected 1)`);
}

console.log(`Audited ${pages} pages, ${imgs} <img> tags.`);
if (problems.length) {
	console.error(problems.map((p) => '✗ ' + p).join('\n'));
	process.exit(1);
}
console.log('✓ All images are WebP with alt text; every page has title, description, canonical and one h1.');
