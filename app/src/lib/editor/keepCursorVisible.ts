import type { Editor } from "@tiptap/core";

// Keep the text cursor visible above a floating bottom toolbar while typing.
//
// Two layouts reuse TomboyEditor with a toolbar overlaying the bottom strip,
// and the browser's native "scroll the caret into view" only guarantees the
// caret reaches the bottom EDGE of the scroll area — exactly the strip the
// toolbar covers — so a caret on the last visible line ends up hidden until
// the user scrolls by hand. This watches caret-moving edits (typing /
// selection / taps) and nudges just enough that the caret clears the toolbar.
// It deliberately does NOT react to viewport scroll/resize events — doing so
// would fight the user's own scrolling (see the listener block below).
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
	/**
	 * Gate for the scroll nudge. Read fresh on every check(), so a caller can
	 * flip the module off live (the 설정 → 디버그 toggle does this on mobile).
	 * Defaults to always-on; desktop container mode never passes a disabling
	 * getter, since its overflow scroller is the only thing keeping the caret
	 * above the toolbar.
	 */
	enabled?: () => boolean;
}

// A focus precedes the on-screen keyboard animation; the visualViewport only
// updates after it finishes (~200-300ms). Checks during that window read a
// stale full-height viewport, so a focus holds them until one vv resize
// arrives — or this timeout when none will (keyboard already up / hardware
// keyboard / desktop browser on the mobile route).
const FOCUS_SETTLE_MS = 350;

/**
 * Should ProseMirror's own scrollToSelection be suppressed in favour of
 * installCursorVisibility()?
 *
 * Wired as the `handleScrollToSelection` editor prop wherever the module is
 * installed. It replaces the old static `scrollMargin/scrollThreshold
 * {bottom: 60}` — that magic number drifted from the real toolbar height
 * (drawer rows), double-corrected against the module's own nudge, and PM's
 * window rect ignores `visualViewport.offsetTop` (phantom overflow on iOS
 * while the keyboard pans the viewport). Downward reveals are owned by the
 * module instead, which knows the live toolbar height and true viewport.
 *
 * Mirrors check()'s guards exactly, so we never claim a scroll the module
 * would then refuse: unfocused views, range selections and upward reveals
 * (caret above the visible top) all stay with PM.
 */
export function shouldDeferScrollToSelection(
	view: Editor["view"],
	mode: "window" | "container" = "window",
): boolean {
	if (!view.hasFocus()) return false;
	if (!view.state.selection.empty) return false;
	let caret: { top: number };
	try {
		caret = view.coordsAtPos(view.state.selection.head);
	} catch {
		return false;
	}
	let visibleTop: number;
	if (mode === "container") {
		const scroller = view.dom.parentElement;
		if (!scroller) return false;
		visibleTop = scroller.getBoundingClientRect().top;
	} else {
		visibleTop = window.visualViewport?.offsetTop ?? 0;
	}
	// Caret above the visible area needs an UPWARD scroll, which the module
	// never performs — let PM handle it (default margin, no toolbar at the top).
	if (caret.top < visibleTop) return false;
	return true;
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
	// Pointer gate — collapsed-caret drags (iOS loupe, Android teardrop caret
	// handle) keep the selection EMPTY the whole time, so the selection.empty
	// guard below never engages. Worse, the caret is anchored to the finger,
	// not the document: a nudge doesn't reduce the overflow, so every
	// selectionchange tick would scroll again — a runaway loop that shoves the
	// text out from under the user's finger. While any pointer is down we
	// therefore latch instead of scrolling, and run ONE deferred check when
	// the last pointer lifts. A plain pan (no selection events while down)
	// latches nothing, so lifting the finger never snaps a parked caret back.
	let pointersDown = 0;
	let pendingAfterPointer = false;
	// Focus settle — see FOCUS_SETTLE_MS. While settling, schedule() is a
	// no-op; endSettle() runs the single post-settle check.
	let settling = false;
	let settleTimer = 0;
	let settleResize: (() => void) | null = null;

	const readPx = (el: Element, name: string): number => {
		const raw = getComputedStyle(el).getPropertyValue(name).trim();
		const n = parseFloat(raw);
		return Number.isFinite(n) ? n : 0;
	};

	const check = () => {
		frame = 0;
		// Debug gate (live): module switched off → leave native scroll alone.
		if (opts.enabled && !opts.enabled()) return;
		// A pointer landed between scheduling and this frame — re-latch.
		if (pointersDown > 0) {
			pendingAfterPointer = true;
			return;
		}
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
			// (Only for a document-anchored caret — a finger-anchored caret
			// doesn't move with the scroll, which is what the pointer gate is
			// for.)
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
		if (pointersDown > 0) {
			pendingAfterPointer = true;
			return;
		}
		// endSettle() always runs one check, so latching a flag is redundant.
		if (settling) return;
		if (frame) return;
		frame = requestAnimationFrame(check);
	};

	const endSettle = () => {
		if (!settling) return;
		settling = false;
		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = 0;
		}
		if (settleResize && vv) {
			vv.removeEventListener("resize", settleResize);
			settleResize = null;
		}
		schedule();
	};

	const onFocus = () => {
		// Desktop container has no on-screen keyboard; without a vv there is
		// nothing to wait for either. Check immediately.
		if (mode === "container" || !vv) {
			schedule();
			return;
		}
		if (settling) return; // already armed by a previous focus
		settling = true;
		// ONE-SHOT, self-removing — not a standing vv subscription (a standing
		// resize/scroll listener re-asserts the caret on every viewport tick
		// and fights the user's own scrolling; see the trigger block below).
		settleResize = () => endSettle();
		vv.addEventListener("resize", settleResize);
		settleTimer = window.setTimeout(endSettle, FOCUS_SETTLE_MS);
	};

	// editor 'update' fires for EVERY doc change, including background
	// dispatches (autolink rescan, chat-note streaming, programmatic reloads).
	// Those never request scrollIntoView; nudging on them yanks a reader who
	// scrolled away from a parked caret back down. Mirror PM's own
	// convention: only transactions that asked for scrollIntoView count.
	const onUpdate = (payload?: {
		transaction?: { scrolledIntoView?: boolean };
	}) => {
		if (payload?.transaction && !payload.transaction.scrolledIntoView) return;
		schedule();
	};

	const onPointerDown = () => {
		pointersDown++;
	};
	const onPointerUp = () => {
		pointersDown = Math.max(0, pointersDown - 1);
		if (pointersDown === 0 && pendingAfterPointer) {
			pendingAfterPointer = false;
			schedule();
		}
	};
	const onPointerCancel = () => {
		pointersDown = Math.max(0, pointersDown - 1);
		// The browser took the gesture over (it became a scroll / system
		// gesture) — running the deferred check now would fight that scroll.
		if (pointersDown === 0) pendingAfterPointer = false;
	};

	// Edit-driven triggers ONLY. We must NOT react to viewport events
	// (`visualViewport` "scroll"/"resize"): those fire while the *user* scrolls
	// the page (and while the OS auto-scrolls during a text-selection drag, or
	// the URL bar shows/hides). Reacting to them re-asserts the caret into view
	// on every scroll tick, so the user can't scroll away from the caret — the
	// page snaps back down, and during selection it oscillates against the OS's
	// own scroll. selectionchange/selectionUpdate already cover real caret moves
	// (taps, arrow keys, typing); a viewport scroll never moves the caret, so we
	// have no reason to recompute on it. (The focus settle above arms a
	// self-removing one-shot resize listener per focus transition — that is a
	// bounded wait for the keyboard, not a standing subscription.)
	editor.on("selectionUpdate", schedule);
	editor.on("update", onUpdate);
	editor.on("focus", onFocus);
	// Native caret moves (taps, arrow keys) don't always fire a TipTap
	// transaction, but the document-level selectionchange does.
	document.addEventListener("selectionchange", schedule);
	// Pointer gate listeners — capture phase so a stopPropagation inside the
	// page (action-bar buttons etc.) can't leave the gate stuck closed.
	const pointerOpts = { capture: true, passive: true } as const;
	document.addEventListener("pointerdown", onPointerDown, pointerOpts);
	document.addEventListener("pointerup", onPointerUp, pointerOpts);
	document.addEventListener("pointercancel", onPointerCancel, pointerOpts);

	return () => {
		if (frame) cancelAnimationFrame(frame);
		if (settleTimer) clearTimeout(settleTimer);
		if (settleResize && vv) vv.removeEventListener("resize", settleResize);
		editor.off("selectionUpdate", schedule);
		editor.off("update", onUpdate);
		editor.off("focus", onFocus);
		document.removeEventListener("selectionchange", schedule);
		document.removeEventListener("pointerdown", onPointerDown, pointerOpts);
		document.removeEventListener("pointerup", onPointerUp, pointerOpts);
		document.removeEventListener("pointercancel", onPointerCancel, pointerOpts);
	};
}
