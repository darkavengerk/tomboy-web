// Expose the on-screen keyboard height as `--keyboard-inset` on <html>, so
// the app shell's `bottom` rises by that amount and the toolbar always sits
// right above the keyboard.
//
// Sizing model: the shell uses `position: fixed; top: 0; bottom:
// var(--keyboard-inset)` instead of `height: 100dvh`. dvh has been
// observed to stay stale on iOS Safari while the keyboard is up, which
// left a gap below the toolbar even when the inset was computed
// correctly. `top`/`bottom` against the layout viewport sidesteps the
// dvh code path entirely.
//
//   - iOS Safari ignores `interactive-widget=resizes-content` and
//     overlays the keyboard: `innerHeight` (layout viewport) stays full,
//     `visualViewport.height` shrinks to the area above the keyboard.
//     The difference is the keyboard height; the shell's `bottom` rises
//     by that much.
//   - Browsers that honor the meta resize the layout viewport themselves:
//     `innerHeight` and `vv.height` shrink together, the difference
//     stays near 0, and `bottom: 0` already lines up with the new
//     layout-viewport bottom.
//
// Why not pin the shell to `visualViewport.height` directly: it left a
// blank strip whenever the Safari URL bar was visible and fought iOS's
// scroll-to-focus (jitter inside an active editor, because every
// `visualViewport.scroll` event repositioned the shell). Sizing against
// the layout viewport with `top`/`bottom` avoids both — the layout
// viewport doesn't move when iOS pans the visual viewport.

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
	};

	update();
	// Only `resize` — `scroll` fires continuously while iOS pans the visual
	// viewport to keep the focused input visible, and reacting to it made
	// the shell fight that adjustment (visible as rapid jitter).
	vv.addEventListener('resize', update);

	return () => {
		vv.removeEventListener('resize', update);
		root.style.removeProperty('--keyboard-inset');
	};
}
