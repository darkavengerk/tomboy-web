import type { Editor } from "@tiptap/core";

// Keep the text cursor visible above the fixed bottom toolbar while typing.
//
// The mobile note route (/note/[id]) scrolls the whole *document* and overlays
// a `position: fixed` toolbar at the viewport bottom. The browser's native
// "scroll the caret into view" only guarantees the caret reaches the bottom
// EDGE of the (visual) viewport — which is exactly the strip the toolbar
// covers — so a caret on the last visible line ends up hidden behind the
// toolbar until the user scrolls by hand. This watches selection / typing /
// keyboard changes and nudges the document up just enough that the caret
// clears the toolbar (and, on keyboard-overlay browsers, the keyboard).
//
// It reads `--toolbar-height` (set on <html> only by the mobile note page) and
// is a no-op when that is absent or zero, so desktop windows that reuse
// TomboyEditor keep their native scroll behaviour untouched.
//
// Coordinate model: `coordsAtPos` returns client (visual-viewport-relative)
// rects. The bottom edge of the visible area in that space is
// `visualViewport.offsetTop + visualViewport.height` — on iOS the keyboard
// overlays and `vv.height` shrinks (so it already excludes the keyboard); on
// browsers that resize the layout viewport, `vv.height ≈ innerHeight`. The
// fixed toolbar rides just above the keyboard either way, so the first
// obscured pixel is `visibleBottom - toolbarHeight`.
export function installCursorVisibility(editor: Editor): () => void {
	if (typeof window === "undefined") return () => {};
	const vv = window.visualViewport;
	const root = document.documentElement;

	let frame = 0;

	const readPx = (name: string): number => {
		const raw = getComputedStyle(root).getPropertyValue(name).trim();
		const n = parseFloat(raw);
		return Number.isFinite(n) ? n : 0;
	};

	const check = () => {
		frame = 0;
		const view = editor.view;
		if (!view || view.isDestroyed) return;
		// Only nudge while this editor actually owns the caret — otherwise a
		// background selectionchange could scroll the page out from under the
		// user.
		if (!view.hasFocus()) return;

		const toolbarH = readPx("--toolbar-height");
		// No mobile toolbar in play (desktop window, terminal view, …) → leave
		// the browser's native scroll behaviour alone.
		if (toolbarH <= 0) return;

		let caret: { bottom: number };
		try {
			caret = view.coordsAtPos(view.state.selection.head);
		} catch {
			return;
		}

		const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
		const GAP = 8; // breathing room between the caret and the toolbar
		const limit = visibleBottom - toolbarH - GAP;

		const overflow = caret.bottom - limit;
		// >2px guards against a feedback loop: after the scroll the caret sits
		// at ~limit, so the next check finds overflow ≈ 0 and stops.
		if (overflow > 2) {
			window.scrollBy({ top: overflow, left: 0 });
		}
	};

	const schedule = () => {
		if (frame) return;
		frame = requestAnimationFrame(check);
	};

	editor.on("selectionUpdate", schedule);
	editor.on("update", schedule);
	editor.on("focus", schedule);
	// Native caret moves (taps, arrow keys) don't always fire a TipTap
	// transaction, but the document-level selectionchange does.
	document.addEventListener("selectionchange", schedule);
	// Keyboard show/hide and viewport shifts change `limit`.
	vv?.addEventListener("resize", schedule);
	vv?.addEventListener("scroll", schedule);

	return () => {
		if (frame) cancelAnimationFrame(frame);
		editor.off("selectionUpdate", schedule);
		editor.off("update", schedule);
		editor.off("focus", schedule);
		document.removeEventListener("selectionchange", schedule);
		vv?.removeEventListener("resize", schedule);
		vv?.removeEventListener("scroll", schedule);
	};
}
