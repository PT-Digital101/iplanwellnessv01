import type { APIRoute } from 'astro';
import { LAUNCHED } from '../consts';

export const GET: APIRoute = ({ site }) =>
	new Response(
		!LAUNCHED || import.meta.env.PUBLIC_NOINDEX === 'true'
			? 'User-agent: *\nDisallow: /\n'
			: `User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap-index.xml', site).href}\n`,
		{
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		},
	);
