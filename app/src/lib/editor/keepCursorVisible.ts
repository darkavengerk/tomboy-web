import type { Editor } from "@tiptap/core";

// Keep the text cursor visible above a floating bottom toolbar while typing.
//
// Two layouts reuse TomboyEditor with a toolbar overlaying the bottom strip,
// and the browser's native "scroll the caret into view" only guarantees the
// caret reaches the bottom EDGE of the scroll area — exactly the strip the
// toolbar covers — so a caret on the last visible line ends up hidden until
// the user scrolls by hand. This watches selection / typing / keyboard /
// viewport changes and nudges just enough that the caret clears the toolbar.
//
//   mode "window"  — mobile note route (/note/[id]). The whole *document*
//     scrolls and a `position: fixed` toolbar rides above the keyboard.
//     Obstruction height is `--toolbar-height` (set on <html> by that page);
//     the visible bottom is `visualViewport.offsetTop + height` (which already
//     excludes an overlaying iOS keyboard). We scroll via `window.scrollBy`.
//
//   mode "container" — desktop NoteWindow (/desktop). The editor's own
//     overflow parent scrolls and an absolutely-positioned 30px toolbar sits
//     at the container's bottom (only while the window is focused).
//     Obstruction height is `--toolbar-h`; the visible bottom is the
//     scroller's `getBoundingClientRect().bottom`. We scroll the container.
//
// In both modes it is a no-op when the toolbar var is absent or zero, so any
// surface that mounts TomboyEditor without a floating toolbar (terminal view,
// an unfocused desktop window) keeps native scroll behaviour untouched.
//
// `coordsAtPos` returns client (visual-viewport-relative) rects, so the caret
// bottom is directly comparable to both the visualViewport bottom and a
// container's bounding-rect bottom.
export interface CursorVisibilityOptions {
	/** Scroll model. Defaults to "window" (mobile body-scroll layout). */
	mode?: "window" | "container";
}

export function installCursorVisibility(
	editor: Editor,
	opts: CursorVisibilityOptions = {},
): () => void {
	if (typeof window === "undefined") return () => {};
	const mode = opts.mode ?? "window";
	const toolbarVar = mode === "container" ? "--toolbar-h" : "--toolbar-height";
	const vv = window.visualViewport;

	let frame = 0;

	const readPx = (el: Element, name: string): number => {
		const raw = getComputedStyle(el).getPropertyValue(name).trim();
		const n = parseFloat(raw);
		return Number.isFinite(n) ? n : 0;
	};

	const check = () => {
		frame = 0;
		const view = editor.view;
		if (!view || view.isDestroyed) return;
		// Only nudge while this editor actually owns the caret — otherwise a
		// background selectionchange could scroll the page out from under the
		// user (and a desktop window only shows its toolbar while focused).
		if (!view.hasFocus()) return;
		// Only act on a collapsed typing caret. A non-empty range means the
		// user is in native text-selection mode (mobile long-press handles /
		// magnifier), where the OS auto-scrolls to keep the selection handle
		// visible. Nudging here fights that scroll and produces a jumpy
		// snap-to-bottom / oscillation. Selection collapses again the moment
		// the user types, so the typing case is unaffected.
		if (!view.state.selection.empty) return;

		let caret: { bottom: number };
		try {
			caret = view.coordsAtPos(view.state.selection.head);
		} catch {
			return;
		}

		const GAP = 8; // breathing room between the caret and the toolbar

		if (mode === "container") {
			// Desktop window: scroll the editor's own overflow parent (the same
			// element `scrollEditorToBottom` drives). The toolbar is a strip at
			// the container's bottom edge.
			const scroller = view.dom.parentElement;
			if (!scroller) return;
			const toolbarH = readPx(scroller, toolbarVar);
			// No floating toolbar in play (unfocused, terminal note, …) → leave
			// native scroll alone.
			if (toolbarH <= 0) return;
			const limit = scroller.getBoundingClientRect().bottom - toolbarH - GAP;
			const overflow = caret.bottom - limit;
			// >2px guards against a feedback loop: after the scroll the caret
			// sits at ~limit, so the next check finds overflow ≈ 0 and stops.
			if (overflow > 2) scroller.scrollTop += overflow;
			return;
		}

		// Mobile: whole document scrolls, fixed toolbar above the keyboard.
		const toolbarH = readPx(document.documentElement, toolbarVar);
		if (toolbarH <= 0) return;
		const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
		const limit = visibleBottom - toolbarH - GAP;
		const overflow = caret.bottom - limit;
		if (overflow > 2) window.scrollBy({ top: overflow, left: 0 });
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
	// Keyboard show/hide and viewport shifts change the limit (window mode).
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
