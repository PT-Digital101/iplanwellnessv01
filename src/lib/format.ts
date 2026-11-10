export const formatDate = (d: Date) =>
	d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Bangkok' }).toUpperCase();

/** Trim text to a meta-description length on a word/space boundary. */
export function metaDescription(text: string, max = 158) {
	const clean = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
	if (clean.length <= max) return clean;
	const cut = clean.slice(0, max);
	const sp = cut.lastIndexOf(' ');
	return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,\s]+$/, '') + '…';
}
