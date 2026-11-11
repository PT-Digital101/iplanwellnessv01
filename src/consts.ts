// Global site settings. URLs/paths live here so they can be aligned with the
// existing WordPress permalinks (from the All in One SEO export) in one place.

/** Canonical origin from `const SITE` in astro.config.mjs (rewritten by Foxworks at "Go live"), no trailing slash. */
const ORIGIN = String(import.meta.env.SITE).replace(/\/$/, '');

/**
 * Indexing switch. Pages are indexable only on a production build (Workers Builds of `main`) whose SITE is the
 * real domain, i.e. after "Go live" in Foxworks. Every preview and every *.workers.dev build stays noindex and
 * robots.txt disallows crawling, so the preview never competes with the live WordPress site in Google.
 */
export const LAUNCHED = import.meta.env.PUBLIC_SITE_ENV === 'production' && !new URL(ORIGIN).hostname.endsWith('.workers.dev');

export const SITE = {
	name: 'iPlan Wellness',
	legalName: 'iPlan Wellness',
	url: ORIGIN,
	locale: 'th_TH',
	lang: 'th',
	tagline: 'The Complete Wellness Agency',
	title: 'Healthcare and Wellness Digital Marketing Agency',
	description:
		'iPlan Wellness เอเจนซี่การตลาดดิจิทัลสำหรับธุรกิจ Healthcare และ Wellness ครบวงจร ตั้งแต่ Brand Strategy, Brand Identity, Website & SEO, Digital Marketing ไปจนถึง Video Production',
	poweredBy: 'IPlan Digital Agency',
	/** Optional YouTube/Vimeo links. When empty, the play buttons are hidden. */
	brandFilmUrl: 'https://www.youtube.com/watch?v=XHxnOOWUoJw',
	showreelUrl: 'https://www.youtube.com/watch?v=Rzj-5FoNxaQ',
	/** Where the contact form POSTs: the Worker route in src/pages/api/contact.ts. */
	contactFormAction: '/api/contact/',
	/**
	 * Cloudflare Turnstile (spam protection) public site key. The matching secret lives only in the
	 * Worker as the TURNSTILE_SECRET secret, never in this repo. PUBLIC_TURNSTILE_SITE_KEY overrides it
	 * for local testing (Cloudflare's always-pass test key is 1x00000000000000000000AA).
	 */
	turnstileSiteKey: (import.meta.env.PUBLIC_TURNSTILE_SITE_KEY as string | undefined) || '0x4AAAAAAF7jIetbnrEG5wR-',
} as const;

export const CONTACT = {
	email: 'hello@iplandigital.com',
	phone: '0899876444',
	phoneIntl: '+66899876444',
	line: '@iplandigital',
	lineUrl: 'https://page.line.me/638vpxid',
	hours: 'Mon-Fri: 09:00 – 18:00 น.',
	addressShort: 'อาคารศุภาคาร ช้อปปิ้งเซ็นเตอร์ (ชั้น 3 ห้อง 3A.09) ถนนเจริญนคร คลองสาน กรุงเทพฯ 10600',
	addressFull:
		'อาคารศุภาคาร ช้อปปิ้งเซ็นเตอร์ (ชั้น 3 ห้อง 3A.09) เลขที่ 723 ถนนเจริญนคร แขวงคลองต้นไทร เขตคลองสาน กรุงเทพมหานคร 10600',
	address: {
		streetAddress: '723 ถนนเจริญนคร อาคารศุภาคาร ช้อปปิ้งเซ็นเตอร์ ชั้น 3 ห้อง 3A.09',
		addressLocality: 'คลองสาน',
		addressRegion: 'กรุงเทพมหานคร',
		postalCode: '10600',
		addressCountry: 'TH',
	},
	mapQuery: 'อาคารศุภาคาร ช้อปปิ้งเซ็นเตอร์ ถนนเจริญนคร คลองสาน กรุงเทพ',
} as const;

// These mirror the live WordPress permalinks exactly (checked against the Rank Math sitemaps)
// so existing Google rankings and backlinks carry over without redirects.
export const PATHS = {
	home: '/',
	services: '/our-services/',
	service: (slug: string) => `/${slug}/`,
	about: '/about-us/',
	blog: '/blog/',
	/** WordPress permalink structure: /%category%/%postname%/ */
	post: (post: { data: { categorySlug: string; slug: string } }) => `/${post.data.categorySlug}/${post.data.slug}/`,
	category: (slug: string) => `/category/${slug}/`,
	contact: '/contact-us/',
	privacy: '/privacy/',
	terms: '/terms-conditions/',
	sitemap: '/sitemap/',
} as const;

export const NAV = [
	{ label: 'Home', href: PATHS.home },
	{ label: 'Our Services', href: PATHS.services, mega: true },
	{ label: 'Blog', href: PATHS.blog },
	{ label: 'About Us', href: PATHS.about },
	{ label: 'Contact Us', href: PATHS.contact },
] as const;

export const CTA_LABEL = 'สร้างแบรนด์กับเรา';
