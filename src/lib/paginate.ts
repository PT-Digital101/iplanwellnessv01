export const POSTS_PER_PAGE = 12;

/** WordPress-style page URLs: /blog/, /blog/page/2/, … */
export const pageHref = (base: string, n: number) => (n === 1 ? base : `${base}page/${n}/`);

/** Split items into pages and return static-path entries for a `[...page]` route. */
export function pagePaths<T>(items: T[], perPage = POSTS_PER_PAGE) {
	const total = Math.max(1, Math.ceil(items.length / perPage));
	return Array.from({ length: total }, (_, i) => ({
		page: i === 0 ? undefined : `page/${i + 1}`,
		current: i + 1,
		total,
		items: items.slice(i * perPage, (i + 1) * perPage),
	}));
}
