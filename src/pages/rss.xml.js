import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE, PATHS } from '../consts';

export async function GET(context) {
	const posts = (await getCollection('blog', (p) => !p.data.noindex)).sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
	return rss({
		title: `${SITE.name} – Wellness Insights`,
		description: SITE.description,
		site: context.site,
		customData: '<language>th-th</language>',
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			categories: [post.data.category, ...post.data.tags],
			link: PATHS.post(post),
		})),
	});
}
