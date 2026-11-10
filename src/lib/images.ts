import type { ImageMetadata } from 'astro';
import registry from '../data/images.json';

const files = import.meta.glob<{ default: ImageMetadata }>('/src/assets/images/**/*.webp', { eager: true });

export type ImageKey = Exclude<keyof typeof registry, '_readme'>;

/** Resolve a path inside src/assets/images (e.g. "blog/foo.webp") to an imported asset. */
export function assetFor(src: string): ImageMetadata {
	if (!src.endsWith('.webp')) throw new Error(`[images] "${src}" is not a .webp file. Convert it with \`npm run images\`.`);
	const mod = files[`/src/assets/images/${src}`];
	if (!mod) throw new Error(`[images] Missing file src/assets/images/${src}. Run \`npm run images:placeholders\` or add the real image.`);
	return mod.default;
}

/** Look up a registered image (file + alt text) by key from src/data/images.json. */
export function image(key: string): { asset: ImageMetadata; alt: string } {
	const entry = (registry as unknown as Record<string, { src: string; alt: string }>)[key];
	if (!entry) throw new Error(`[images] Unknown image key "${key}" – add it to src/data/images.json`);
	if (!entry.alt?.trim()) throw new Error(`[images] Image "${key}" has no alt text in src/data/images.json`);
	return { asset: assetFor(entry.src), alt: entry.alt };
}
