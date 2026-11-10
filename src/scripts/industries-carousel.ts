// Curved 3D industries carousel (home page).
//
// Desktop (fine pointer, ≥900px): cards sit on the inside of a cylinder and loop endlessly. The
//   track is driven by GSAP's ticker: drag (with momentum), page scroll, horizontal wheel,
//   prev/next buttons, keyboard focus, plus a slow idle drift. The card set is cloned once in the
//   browser so the loop never shows a gap; clones are inert and hidden from assistive tech.
// Touch / small screens: native swipe with scroll-snap, and a lighter curve applied per frame.
// prefers-reduced-motion or no JS: the plain flat row from the HTML/CSS.
import { gsap } from 'gsap';

const DESKTOP = '(min-width: 900px) and (pointer: fine)';
const REDUCED = '(prefers-reduced-motion: reduce)';

export function initIndustriesCarousel(root: HTMLElement) {
	if (matchMedia(REDUCED).matches) return;
	const scroller = root.querySelector<HTMLElement>('.industries');
	const track = root.querySelector<HTMLElement>('.industries__track');
	if (!scroller || !track) return;
	if (matchMedia(DESKTOP).matches) desktop(root, scroller, track);
	else touch(root, scroller, track);
}

/** Inside-of-cylinder curve: edges tilt toward the viewer and come closer. n = -1 (left edge) … 1 (right edge). */
const curve = (n: number, maxAngle: number, depth: number) => {
	const c = gsap.utils.clamp(-1.4, 1.4, n);
	return { angle: -c * maxAngle, z: c * c * depth };
};

function desktop(root: HTMLElement, scroller: HTMLElement, track: HTMLElement) {
	const originals = [...track.children] as HTMLElement[];
	for (const li of originals) {
		const clone = li.cloneNode(true) as HTMLElement;
		clone.setAttribute('aria-hidden', 'true');
		clone.inert = true;
		clone.dataset.clone = '';
		track.append(clone);
	}
	const items = [...track.children] as HTMLElement[];
	scroller.classList.add('industries--3d');

	let cardW = 0, step = 0, total = 0, viewW = 0;
	const measure = () => {
		cardW = items[0].offsetWidth;
		step = cardW + parseFloat(getComputedStyle(track).columnGap || '24');
		total = step * items.length;
		viewW = track.clientWidth;
	};
	measure();

	// Positions are in px along the loop. Start centred between the 3rd and 4th cards.
	let current = step * 2.5;
	let target = current;
	let dragging = false;
	let hovering = false;
	let inView = false;
	const wrap = () => gsap.utils.wrap(-total / 2, total / 2);
	let wrapPos = wrap();

	const render = () => {
		const half = viewW / 2;
		for (let i = 0; i < items.length; i++) {
			const x = wrapPos(i * step - current); // card centre relative to the viewport centre
			const { angle, z } = curve(x / half, 24, 90);
			items[i].style.transform = `translate3d(${half + x - cardW / 2}px,0,${z}px) rotateY(${angle}deg)`;
			items[i].style.zIndex = String(1000 - Math.round(Math.abs(x)));
		}
	};

	gsap.ticker.add((_t, deltaMs) => {
		if (!inView) return;
		if (!dragging && !hovering) target += deltaMs * 0.018; // idle drift ≈ 18px/s
		current += (target - current) * 0.1;
		render();
	});

	// Only animate while the section is on screen.
	new IntersectionObserver(([e]) => (inView = e.isIntersecting), { rootMargin: '200px' }).observe(root);

	// Page scroll turns the carousel.
	let lastY = scrollY;
	addEventListener(
		'scroll',
		() => {
			const dy = scrollY - lastY;
			lastY = scrollY;
			if (inView && !dragging) target += dy * 0.6;
		},
		{ passive: true },
	);

	// Horizontal trackpad / shift-wheel scrolls it directly; vertical wheel is left to the page.
	track.addEventListener(
		'wheel',
		(e) => {
			if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
				e.preventDefault();
				target += e.deltaX;
			}
		},
		{ passive: false },
	);

	// Drag with momentum. Suppress the click if the pointer actually moved.
	let startX = 0, startTarget = 0, lastX = 0, lastT = 0, velocity = 0, moved = false;
	track.addEventListener('pointerdown', (e) => {
		if (e.button !== 0) return;
		dragging = true;
		moved = false;
		startX = lastX = e.clientX;
		startTarget = target;
		lastT = performance.now();
		velocity = 0;
	});
	track.addEventListener('pointermove', (e) => {
		if (!dragging) return;
		const now = performance.now();
		const dx = e.clientX - startX;
		// Only become a drag after real movement. Capturing the pointer on pointerdown would
		// retarget the click to the track, so a plain click on a card would never reach its link.
		if (!moved && Math.abs(dx) > 6) {
			moved = true;
			track.setPointerCapture(e.pointerId);
			root.classList.add('is-dragging');
		}
		if (!moved) return;
		target = startTarget - dx;
		velocity = (lastX - e.clientX) / Math.max(1, now - lastT);
		lastX = e.clientX;
		lastT = now;
	});
	const end = () => {
		if (!dragging) return;
		dragging = false;
		root.classList.remove('is-dragging');
		target += velocity * 180; // fling
	};
	track.addEventListener('pointerup', end);
	track.addEventListener('pointercancel', end);
	track.addEventListener('click', (e) => moved && (e.preventDefault(), e.stopPropagation()), true);
	track.addEventListener('dragstart', (e) => e.preventDefault());

	track.addEventListener('pointerenter', () => (hovering = true));
	track.addEventListener('pointerleave', () => (hovering = false));

	// Keyboard: tabbing to a card brings it to the centre.
	track.addEventListener('focusin', (e) => {
		const li = (e.target as HTMLElement).closest('li');
		const i = li ? items.indexOf(li) : -1;
		if (i < 0) return;
		hovering = true;
		target = current + wrapPos(i * step - current);
	});
	track.addEventListener('focusout', () => (hovering = false));

	// Buttons move exactly one card and settle with it centred.
	const go = (dir: number) => (target = Math.round(target / step + dir) * step);
	root.querySelector('[data-carousel-prev]')?.addEventListener('click', () => go(-1));
	root.querySelector('[data-carousel-next]')?.addEventListener('click', () => go(1));

	addEventListener('resize', () => {
		measure();
		wrapPos = wrap();
		render();
	});
	render();
}

function touch(root: HTMLElement, scroller: HTMLElement, track: HTMLElement) {
	const items = [...track.children] as HTMLElement[];
	scroller.classList.add('industries--curved');
	let queued = false;
	const render = () => {
		queued = false;
		const box = scroller.getBoundingClientRect();
		const half = box.width / 2;
		for (const li of items) {
			const r = li.getBoundingClientRect();
			const x = r.left + r.width / 2 - (box.left + half);
			const { angle, z } = curve(x / half, 14, 40);
			li.style.transform = `translateZ(${z}px) rotateY(${angle}deg)`;
		}
	};
	const queue = () => !queued && ((queued = true), requestAnimationFrame(render));
	scroller.addEventListener('scroll', queue, { passive: true });
	addEventListener('resize', queue);
	render();

	root.querySelector('[data-carousel-prev]')?.addEventListener('click', () => scroller.scrollBy({ left: -items[0].offsetWidth, behavior: 'smooth' }));
	root.querySelector('[data-carousel-next]')?.addEventListener('click', () => scroller.scrollBy({ left: items[0].offsetWidth, behavior: 'smooth' }));
}
