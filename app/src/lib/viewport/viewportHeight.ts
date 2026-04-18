// Expose the on-screen keyboard height as `--keyboard-inset` on <html>, so
// the app shell can pad its bottom by that amount and the toolbar always sits
// right above the keyboard.
//
// Why this shape (keyboard inset instead of pinning the shell to the visual
// viewport height):
//   - iOS Safari treats the virtual keyboard as an overlay and never shrinks
//     the layout / dynamic viewport. `100dvh` alone leaves the toolbar under
//     the keyboard.
//   - Android Chrome shrinks the layout viewport only with
//     `interactive-widget=resizes-content` — there the inset is 0 and this
//     variable is a no-op.
//   - Pinning the shell to `visualViewport.height` instead worked for the
//     keyboard case but left a blank strip below the toolbar whenever the
//     browser chrome (Safari URL bar) took space, and caused the shell to
//     fight iOS's scroll-to-focus (jittering while scrolling inside an
//     active editor because every `visualViewport.scroll` event repositioned
//     the shell).
//
// With `height: 100dvh` + `padding-bottom: var(--keyboard-inset)` the shell
// fills the dynamic viewport normally and only shrinks from the bottom when
// a real keyboard is open.

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
		// virtual keyboard is always well above ~120px. Filter the noise so
		// the shell doesn't twitch while the browser chrome settles.
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
