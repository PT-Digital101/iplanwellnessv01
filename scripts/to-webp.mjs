// Convert real photos (jpg/png/avif/tiff/webp) into optimised WebP with an SEO file name.
//
//   npm run images -- ./photos/IMG_2231.jpg --to home/healthcare-wellness-digital-marketing-agency-hero.webp
//   npm run images -- ./photos/*.jpg --dir services        (file names are slugified automatically)
//
// --to   exact target path inside src/assets/images (single file only, use the name from src/data/images.json)
// --dir  target folder inside src/assets/images; each output name = slugified input name
// --max  max width in px (default 2400). Quality 82.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMG_DIR = path.join(ROOT, 'src/assets/images');
const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return undefined;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
};
const to = opt('to');
const dir = opt('dir');
const max = Number(opt('max') ?? 2400);
const inputs = args;

if (!inputs.length || (!to && !dir) || (to && inputs.length > 1)) {
	console.error('Usage: npm run images -- <file> --to <folder/seo-name.webp> | <files…> --dir <folder>');
	process.exit(1);
}

export const slugify = (s) =>
	s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9฀-๿]+/g, '-')
		.replace(/^-+|-+$/g, '');

for (const input of inputs) {
	const rel = to ?? path.join(dir, `${slugify(path.parse(input).name)}.webp`);
	if (!rel.endsWith('.webp')) throw new Error(`Target must end in .webp: ${rel}`);
	const out = path.join(IMG_DIR, rel);
	await mkdir(path.dirname(out), { recursive: true });
	const info = await sharp(input)
		.rotate()
		.resize({ width: max, withoutEnlargement: true })
		.webp({ quality: 82, effort: 5 })
		.toFile(out);
	console.log(`${input} → src/assets/images/${rel} (${info.width}×${info.height}, ${Math.round(info.size / 1024)} KB)`);
}
console.log('Remember to update the alt text in src/data/images.json (or the post frontmatter).');
