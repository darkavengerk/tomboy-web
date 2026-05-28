// Expose two CSS variables on <html> so the app shell stays aligned with
// the visible (visual) viewport while the on-screen keyboard is up:
//
//   --keyboard-inset : keyboard height (innerHeight − vv.height)
//   --vv-offset      : how far iOS has panned the visual viewport down
//                      inside the layout viewport (vv.offsetTop)
//
// The shell uses `top: var(--vv-offset)` and
// `bottom: calc(var(--keyboard-inset) - var(--vv-offset))` so its box
// tracks the visual viewport exactly. Without `--vv-offset`, iOS's
// automatic scroll-to-focus moved the visual viewport but the shell
// stayed pinned to the layout viewport, leaving a strip of body
// background visible below the toolbar (= the original bug).
//
//   - iOS Safari ignores `interactive-widget=resizes-content`, overlays
//     the keyboard, and pans the visual viewport. Both variables are
//     non-zero here.
//   - Browsers that honor the meta resize the layout viewport and don't
//     pan the visual viewport. Both variables stay at 0.
//
// Why we now listen to `scroll` even though an earlier note here warned
// against it: the earlier attempt pinned the shell's `height` to
// `vv.height` AND chased `vv.offsetTop` simultaneously, which moved the
// cursor out of the visual viewport and made iOS pan again, looping.
// Here only `top` chases `offsetTop`; height is derived from inset, so
// the cursor stays inside the shell and iOS settles after one pan.

export function bindViewportHeight(): () => void {
	if (typeof window === 'undefined') return () => {};
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const root = document.documentElement;

	const update = () => {
		// `innerHeight` tracks the layout viewport (shrinks with browser
		// chrome on iOS Safari, shrinks with the keyboard on Android when
		// `interactive-widget=resizes-content`). `vv.height` shrinks with
		// the keyboard in addition to all of that. Their difference is the
		// keyboard height on browsers that overlay the keyboard.
		const inset = Math.max(0, window.innerHeight - vv.height);
		// Small diffs come from URL-bar / tap-highlight transitions; the
		// virtual keyboard is always well above ~120px. Filter the noise
		// so the shell doesn't twitch while the browser chrome settles.
		root.style.setProperty('--keyboard-inset', inset > 80 ? `${inset}px` : '0px');
		root.style.setProperty('--vv-offset', `${vv.offsetTop}px`);
	};

	update();
	vv.addEventListener('resize', update);
	vv.addEventListener('scroll', update);

	return () => {
		vv.removeEventListener('resize', update);
		vv.removeEventListener('scroll', update);
		root.style.removeProperty('--keyboard-inset');
		root.style.removeProperty('--vv-offset');
	};
}
