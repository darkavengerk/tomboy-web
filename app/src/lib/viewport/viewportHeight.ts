// Expose the on-screen keyboard height as `--keyboard-inset` on <html>, so
// the app shell can pad its bottom by that amount and the toolbar always
// sits right above the keyboard.
//
// Two-mode design: app.html ships `interactive-widget=resizes-content`.
//
//   - Browsers that honor the meta shrink `100dvh` with the keyboard
//     themselves. The shell is already sized to the visible area —
//     adding a JS inset on top would double-count the keyboard and
//     leave dead whitespace below the toolbar.
//   - iOS Safari ignores the meta and treats the keyboard as a pure
//     overlay. There `100dvh` stays at the full layout viewport and we
//     have to measure the overlap (`innerHeight - vv.height`) ourselves.
//
// A hidden probe element with `height: 100dvh` tells us which mode the
// UA is currently in: when its measured height already matches the
// visual viewport, the browser is doing the work and we hold inset at 0.
//
// Why not pin the shell to `visualViewport.height` directly: it left a
// blank strip below the toolbar whenever the Safari URL bar was visible
// and fought iOS's scroll-to-focus (jitter while scrolling inside an
// active editor, since every `visualViewport.scroll` event repositioned
// the shell).

export function bindViewportHeight(): () => void {
	if (typeof window === 'undefined') return () => {};
	const vv = window.visualViewport;
	if (!vv) return () => {};

	const root = document.documentElement;

	// Hidden probe — reads how the UA currently resolves `100dvh`.
	const probe = document.createElement('div');
	probe.style.cssText =
		'position:fixed; top:0; left:0; width:1px; height:100dvh; ' +
		'visibility:hidden; pointer-events:none; z-index:-1;';
	document.body.appendChild(probe);

	const update = () => {
		const dvhPx = probe.getBoundingClientRect().height;
		const vvH = vv.height;
		// dvh already shrank to the visible-above-keyboard area? Then the
		// shell is correctly sized — applying inset would double-subtract.
		// Tolerance covers fractional rounding + the few-px gap UAs leave
		// between dvh and the visual viewport.
		if (dvhPx <= vvH + 40) {
			root.style.setProperty('--keyboard-inset', '0px');
			return;
		}
		// Overlay mode: UA leaves dvh at the full layout viewport. Compute
		// the keyboard overlap ourselves; small diffs are URL-bar / tap-
		// highlight noise, real keyboards are well above 80px.
		const inset = Math.max(0, window.innerHeight - vvH);
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
		probe.remove();
	};
}
