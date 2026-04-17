// Track the visual viewport height and expose it as the CSS variable
// `--viewport-height` on <html>. This exists so mobile layouts can size
// themselves to the area actually visible above the on-screen keyboard.
//
// `100dvh` alone is not enough:
//   - iOS Safari treats the virtual keyboard as an overlay and never
//     shrinks the layout/dynamic viewport for it.
//   - Android Chrome only shrinks the layout viewport when the viewport
//     meta has `interactive-widget=resizes-content` — and even then the
//     visual viewport is the authoritative source on older versions.
//
// Using `window.visualViewport.height` covers both cases. When the API
// is unavailable we leave the variable unset and callers fall back to
// `100dvh` via `var(--viewport-height, 100dvh)`.

export function bindViewportHeight(): () => void {
	if (typeof window === 'undefined') return () => {};
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const root = document.documentElement;

	const update = () => {
		root.style.setProperty('--viewport-height', `${vv.height}px`);
	};

	update();
	vv.addEventListener('resize', update);
	vv.addEventListener('scroll', update);

	return () => {
		vv.removeEventListener('resize', update);
		vv.removeEventListener('scroll', update);
		root.style.removeProperty('--viewport-height');
	};
}
