import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) =>
	new Response(
		import.meta.env.PUBLIC_NOINDEX === 'true'
			? 'User-agent: *\nDisallow: /\n'
			: `User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap-index.xml', site).href}\n`,
		{
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		},
	);
