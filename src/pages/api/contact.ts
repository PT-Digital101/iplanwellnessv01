// Contact form handler (runs on the Cloudflare Worker, not prerendered).
//
// Spam protection, in order: honeypot field, minimum fill time, field validation and link limits,
// then Cloudflare Turnstile verified server-side with TURNSTILE_SECRET.
//
// Delivery: when the Worker has a `send_email` binding named EMAIL (needs Cloudflare Email Routing on
// the domain, see README), the enquiry is emailed to FORM_TO. Until then it answers
// { ok: false, fallback: 'mailto' } and the browser opens the visitor's e-mail app instead, so no
// enquiry is lost before launch.
import type { APIRoute } from 'astro';
import { CONTACT } from '../../consts';

export const prerender = false;

const MIN_FILL_MS = 3000;
const MAX = { first_name: 100, last_name: 100, email: 200, website: 300, budget: 100, message: 5000 } as const;
const ALLOWED_HOSTS = ['iplanwellness.com', 'www.iplanwellness.com', 'iplanwellnessv01.iplandigital.workers.dev', 'localhost'];

type Env = {
	TURNSTILE_SECRET?: string;
	TURNSTILE_SECRET_KEY?: string;
	FORM_TO?: string;
	FORM_FROM?: string;
	EMAIL?: { send(message: unknown): Promise<void> };
};

const json = (body: Record<string, unknown>, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const clean = (v: FormDataEntryValue | null, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** Accept either secret name (the dashboard one was saved as TURNSTILE_SECRET_KEY). */
const turnstileSecret = (env: Env) => env.TURNSTILE_SECRET || env.TURNSTILE_SECRET_KEY;

// Health check: reports only whether each setting is present (never its value).
export const GET: APIRoute = ({ locals }) => {
	const env = ((locals as { runtime?: { env?: Env } }).runtime?.env ?? {}) as Env;
	return json({ turnstileSecret: Boolean(turnstileSecret(env)), emailBinding: Boolean(env.EMAIL) });
};

export const POST: APIRoute = async ({ request, locals }) => {
	const env = ((locals as { runtime?: { env?: Env } }).runtime?.env ?? {}) as Env;

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ ok: false, error: 'bad_request' }, 400);
	}

	// 1. Honeypot: invisible to people, bots fill every field. Pretend success so bots don't retry.
	if (clean(form.get('company_site'), 200)) return json({ ok: true });

	// 2. Too fast to be a person.
	const started = Number(form.get('started_at'));
	if (!started || Date.now() - started < MIN_FILL_MS) return json({ ok: false, error: 'too_fast' }, 400);

	// 3. Validate fields.
	const data = {
		first_name: oneLine(clean(form.get('first_name'), MAX.first_name)),
		last_name: oneLine(clean(form.get('last_name'), MAX.last_name)),
		email: oneLine(clean(form.get('email'), MAX.email)),
		website: oneLine(clean(form.get('website'), MAX.website)),
		budget: oneLine(clean(form.get('budget'), MAX.budget)),
		message: clean(form.get('message'), MAX.message),
	};
	if (!data.first_name || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(data.email)) return json({ ok: false, error: 'invalid' }, 400);
	if ((data.message.match(/https?:\/\//gi) ?? []).length > 3) return json({ ok: false, error: 'spam' }, 400);
	if (/<a\s|\[url=/i.test(data.message)) return json({ ok: false, error: 'spam' }, 400);

	// 4. Turnstile, verified server-side (the browser check alone can be skipped by bots).
	const secret = turnstileSecret(env);
	if (!secret) return json({ ok: false, fallback: 'mailto', error: 'not_configured' }, 503);
	const token = clean(form.get('cf-turnstile-response'), 4096);
	if (!token) return json({ ok: false, error: 'captcha' }, 400);
	const verify = new FormData();
	verify.append('secret', secret);
	verify.append('response', token);
	const ip = request.headers.get('CF-Connecting-IP');
	if (ip) verify.append('remoteip', ip);
	let outcome: { success?: boolean; hostname?: string } = {};
	try {
		outcome = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: verify })).json();
	} catch {
		return json({ ok: false, fallback: 'mailto', error: 'verify_unavailable' }, 503);
	}
	if (!outcome.success) return json({ ok: false, error: 'captcha' }, 400);
	if (outcome.hostname && !ALLOWED_HOSTS.includes(outcome.hostname) && outcome.hostname !== 'example.com') {
		return json({ ok: false, error: 'captcha' }, 400);
	}

	// 5. Deliver.
	if (!env.EMAIL) return json({ ok: false, fallback: 'mailto', error: 'delivery_not_configured' }, 503);
	const to = env.FORM_TO || CONTACT.email;
	const from = env.FORM_FROM || 'website@iplanwellness.com';
	const name = `${data.first_name} ${data.last_name}`.trim();
	const body = [
		'New enquiry from iplanwellness.com',
		'',
		`Name: ${name}`,
		`Email: ${data.email}`,
		`Website / Fanpage: ${data.website || '-'}`,
		`Budget: ${data.budget || '-'}`,
		'',
		'Message:',
		data.message || '-',
		'',
		`Page: ${request.headers.get('referer') ?? '-'}`,
		`Sent: ${new Date().toISOString()}`,
	].join('\n');
	const raw = [
		`From: iPlan Wellness Website <${from}>`,
		`To: ${to}`,
		`Reply-To: ${data.email}`,
		`Subject: =?UTF-8?B?${b64(`New enquiry: ${name}`)}?=`,
		`Message-ID: <${crypto.randomUUID()}@iplanwellness.com>`,
		`Date: ${new Date().toUTCString()}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=UTF-8',
		'Content-Transfer-Encoding: base64',
		'',
		b64(body).replace(/.{76}/g, '$&\r\n'),
	].join('\r\n');

	try {
		// @ts-ignore – runtime module provided by the Workers platform
		const { EmailMessage } = await import('cloudflare:email');
		await env.EMAIL.send(new EmailMessage(from, to, raw));
	} catch (err) {
		console.error('contact form: email send failed', err instanceof Error ? err.message : err);
		return json({ ok: false, fallback: 'mailto', error: 'send_failed' }, 502);
	}
	return json({ ok: true });
};
