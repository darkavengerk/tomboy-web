// Expose the on-screen keyboard height as `--keyboard-inset` on <html>, so
// the fixed bottom toolbar can rise by that amount and stays right above
// the keyboard on browsers that overlay the keyboard (iOS Safari).
//
// Sizing model: mobile routes use body-level scroll (no `position: fixed`
// shell). The OS handles scroll-to-focus by scrolling the document up;
// we don't track `visualViewport.offsetTop` anymore. Only the toolbar's
// bottom anchor needs the keyboard inset.
//
//   - iOS Safari ignores `interactive-widget=resizes-content` and
//     overlays the keyboard: `innerHeight` (layout viewport) stays full,
//     `visualViewport.height` shrinks to the area above the keyboard.
//     Their difference is the keyboard height.
//   - Browsers that honor the meta resize the layout viewport themselves:
//     `innerHeight` and `vv.height` shrink together, the difference
//     stays near 0, and `bottom: 0` already lines up with the new
//     layout-viewport bottom.

export function bindViewportHeight(): () => void {
	if (typeof window === 'undefined') return () => {};
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const root = document.documentElement;

	const update = () => {
		const inset = Math.max(0, window.innerHeight - vv.height);
		// Small diffs come from URL-bar / tap-highlight transitions; the
		// virtual keyboard is always well above ~120px. Filter the noise.
		root.style.setProperty('--keyboard-inset', inset > 80 ? `${inset}px` : '0px');
	};

	update();
	vv.addEventListener('resize', update);

	return () => {
		vv.removeEventListener('resize', update);
		root.style.removeProperty('--keyboard-inset');
	};
}
