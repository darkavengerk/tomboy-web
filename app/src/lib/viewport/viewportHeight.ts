// Track the visual viewport and expose it as CSS variables
// `--viewport-height` / `--viewport-offset-top` on <html>. This exists so
// mobile layouts can pin themselves to the area actually visible above the
// on-screen keyboard.
//
// Height alone (100dvh) is not enough:
//   - iOS Safari treats the virtual keyboard as an overlay and never
//     shrinks the layout/dynamic viewport for it.
//   - Android Chrome only shrinks the layout viewport when the viewport
//     meta has `interactive-widget=resizes-content`; older Chrome,
//     Samsung Internet, and similar behave like iOS.
//
// And even with the correct height, on browsers that don't shrink the
// layout viewport the browser scrolls the *visual* viewport within the
// layout viewport to bring the focused input into view. A container
// sized to `visualViewport.height` but anchored at the top of the layout
// viewport then sits above the visible area — the toolbar floats
// mid-screen with empty body showing below it. `visualViewport.offsetTop`
// gives us that scroll amount so the shell can be pinned to the visible
// area with `position: fixed; top: var(--viewport-offset-top)`.
//
// When the API is unavailable we leave the variables unset and callers
// fall back via `var(--viewport-height, 100dvh)` / `var(--viewport-offset-top, 0px)`.

export function bindViewportHeight(): () => void {
	if (typeof window === 'undefined') return () => {};
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const root = document.documentElement;

	const update = () => {
		root.style.setProperty('--viewport-height', `${vv.height}px`);
		root.style.setProperty('--viewport-offset-top', `${vv.offsetTop}px`);
	};

	update();
	vv.addEventListener('resize', update);
	vv.addEventListener('scroll', update);

	return () => {
		vv.removeEventListener('resize', update);
		vv.removeEventListener('scroll', update);
		root.style.removeProperty('--viewport-height');
		root.style.removeProperty('--viewport-offset-top');
	};
}
