import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installCursorVisibility,
	shouldDeferScrollToSelection,
} from "$lib/editor/keepCursorVisible";

// installCursorVisibility relies on layout APIs jsdom doesn't implement
// (coordsAtPos returns real geometry only with a browser layout engine, and
// there is no visualViewport). We fake just the surface the module touches so
// we can assert its scroll *policy* — specifically that it leaves native
// text-selection scrolling alone.

type FakeOpts = { empty: boolean; caretBottom: number; focused?: boolean };

function makeFakeEditor({ empty, caretBottom, focused = true }: FakeOpts) {
	const listeners = new Map<string, Array<(payload?: unknown) => void>>();
	const view = {
		isDestroyed: false,
		hasFocus: () => focused,
		coordsAtPos: () => ({
			top: caretBottom - 16,
			bottom: caretBottom,
			left: 0,
			right: 0,
		}),
		state: { selection: { head: 1, empty } },
		dom: { parentElement: null as unknown },
	};
	return {
		// only the members installCursorVisibility reads
		view,
		on(event: string, cb: (payload?: unknown) => void) {
			const arr = listeners.get(event) ?? [];
			arr.push(cb);
			listeners.set(event, arr);
		},
		off(event: string, cb: (payload?: unknown) => void) {
			const arr = listeners.get(event) ?? [];
			listeners.set(
				event,
				arr.filter((c) => c !== cb),
			);
		},
		fire(event: string, payload?: unknown) {
			for (const cb of listeners.get(event) ?? []) cb(payload);
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

let scrollBy: ReturnType<typeof vi.fn>;
let vvListeners: string[];
let vvHandlers: Map<string, Set<() => void>>;
let vvStub: {
	offsetTop: number;
	height: number;
	addEventListener: (type: string, h: () => void) => void;
	removeEventListener: (type: string, h: () => void) => void;
};
/** Fire a fake visualViewport event (e.g. the keyboard-driven "resize"). */
function vvFire(type: string) {
	for (const h of [...(vvHandlers.get(type) ?? [])]) h();
}
/** Installs registered here are disposed after each test — the module holds
 *  document-level listeners (selectionchange, pointer gate) that would
 *  otherwise leak across tests and double-fire on dispatched events. */
let disposers: Array<() => void>;
function install(
	editor: ReturnType<typeof makeFakeEditor>,
	opts?: Parameters<typeof installCursorVisibility>[1],
) {
	const dispose = installCursorVisibility(editor, opts);
	disposers.push(dispose);
	return dispose;
}

beforeEach(() => {
	scrollBy = vi.fn();
	disposers = [];
	vi.stubGlobal("scrollBy", scrollBy);
	// rAF runs synchronously so a fired event resolves check() inline.
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		cb(0);
		return 1;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {});
	// 60px toolbar overlaying the bottom of an 800px-tall visible area:
	// limit = 800 - 60 - GAP(8) = 732. A caret bottom at 790 overflows by 58.
	vi.stubGlobal("getComputedStyle", () => ({
		getPropertyValue: (name: string) =>
			name === "--toolbar-height" || name === "--toolbar-h" ? "60px" : "",
	}));
	vvListeners = [];
	vvHandlers = new Map();
	vvStub = {
		offsetTop: 0,
		height: 800,
		addEventListener: (type: string, h: () => void) => {
			vvListeners.push(type);
			const set = vvHandlers.get(type) ?? new Set();
			set.add(h);
			vvHandlers.set(type, set);
		},
		removeEventListener: (type: string, h: () => void) => {
			vvHandlers.get(type)?.delete(h);
		},
	};
	vi.stubGlobal("visualViewport", vvStub);
	(window as unknown as { visualViewport: unknown }).visualViewport = vvStub;
});

afterEach(() => {
	for (const d of disposers) d();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("installCursorVisibility — selection-mode regression", () => {
	it("scrolls a collapsed caret that sits under the toolbar (typing case)", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		editor.fire("selectionUpdate");
		expect(scrollBy).toHaveBeenCalledTimes(1);
		expect(scrollBy).toHaveBeenCalledWith({ top: 58, left: 0 });
	});

	it("does NOT scroll during a non-empty range selection (text-selection mode)", () => {
		const editor = makeFakeEditor({ empty: false, caretBottom: 790 });
		install(editor, { mode: "window" });
		// Mobile long-press fires a stream of selectionchange events as the OS
		// drives its own auto-scroll; we must not fight it.
		editor.fire("selectionUpdate");
		editor.fire("selectionUpdate");
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does not scroll a collapsed caret already above the toolbar", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 400 });
		install(editor, { mode: "window" });
		editor.fire("selectionUpdate");
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does NOT subscribe to visualViewport scroll/resize at install (would fight the user's own scrolling)", () => {
		// A viewport scroll never moves the caret. Re-asserting the caret into
		// view on every scroll tick traps the user at the caret — scrolling up
		// (keyboard open) snaps back down, and selection drags oscillate against
		// the OS auto-scroll. The feature must be edit-driven only. (The focus
		// settle below arms a self-removing ONE-SHOT resize listener per focus
		// transition — that is not a standing subscription.)
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		expect(vvListeners).not.toContain("scroll");
		expect(vvListeners).not.toContain("resize");
	});
});

describe("installCursorVisibility — enabled gate (debug toggle)", () => {
	it("does NOT scroll a collapsed caret under the toolbar when enabled() is false", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window", enabled: () => false });
		editor.fire("selectionUpdate");
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("scrolls when enabled() is true (same as no gate)", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window", enabled: () => true });
		editor.fire("selectionUpdate");
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});

	it("re-reads enabled() live (the check honours a flip, not the install-time value)", () => {
		let on = false;
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window", enabled: () => on });
		// The pointer gate latches the trigger WITHOUT consuming an rAF, so the
		// deferred check on pointerup is a fresh check() — it re-reads enabled()
		// at that moment. A value captured at install (false) would never scroll.
		document.dispatchEvent(new Event("pointerdown"));
		editor.fire("selectionUpdate");
		on = true; // flip AFTER install, BEFORE the deferred check runs
		document.dispatchEvent(new Event("pointerup"));
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});
});

describe("installCursorVisibility — pointer-down gate (collapsed-caret drag)", () => {
	// iOS loupe / Android teardrop caret-handle drags keep the selection
	// COLLAPSED the whole time, so the selection.empty guard never engages.
	// The caret is anchored to the finger (not the document): a nudge doesn't
	// reduce the overflow, so without a gate every selectionchange tick
	// scrolls again — a runaway loop under the user's finger.

	it("suppresses nudges while a pointer is down and runs ONE deferred check on pointerup", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		document.dispatchEvent(new Event("pointerdown"));
		// drag: OS fires a stream of selectionchange while collapsed
		editor.fire("selectionUpdate");
		editor.fire("selectionUpdate");
		editor.fire("selectionUpdate");
		expect(scrollBy).not.toHaveBeenCalled();
		document.dispatchEvent(new Event("pointerup"));
		expect(scrollBy).toHaveBeenCalledTimes(1);
		expect(scrollBy).toHaveBeenCalledWith({ top: 58, left: 0 });
	});

	it("does NOT check on pointerup when nothing was suppressed during the gesture (plain pan must not snap back)", () => {
		// A scroll pan is pointerdown→pointerup with no selection events in
		// between. An unconditional pointerup check would re-nudge a parked
		// caret after every pan — exactly the snap-back 81ba541 removed.
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		document.dispatchEvent(new Event("pointerdown"));
		document.dispatchEvent(new Event("pointerup"));
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("drops the deferred check on pointercancel (browser took the gesture over as a scroll)", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		document.dispatchEvent(new Event("pointerdown"));
		editor.fire("selectionUpdate");
		document.dispatchEvent(new Event("pointercancel"));
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("keeps the gate closed until the LAST pointer lifts (multi-touch)", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		document.dispatchEvent(new Event("pointerdown"));
		document.dispatchEvent(new Event("pointerdown"));
		editor.fire("selectionUpdate");
		document.dispatchEvent(new Event("pointerup"));
		expect(scrollBy).not.toHaveBeenCalled();
		document.dispatchEvent(new Event("pointerup"));
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});

	it("removes its document pointer listeners on dispose", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		const dispose = installCursorVisibility(editor, { mode: "window" });
		dispose();
		document.dispatchEvent(new Event("pointerdown"));
		editor.fire("selectionUpdate");
		document.dispatchEvent(new Event("pointerup"));
		expect(scrollBy).not.toHaveBeenCalled();
	});
});

describe("installCursorVisibility — focus settle (keyboard race)", () => {
	// On mobile the focus event always precedes the keyboard animation; the
	// visualViewport only updates AFTER it finishes. Checking at focus+1 frame
	// reads a stale (full-height) viewport, nudges against the wrong limit,
	// and the real correction then lands on the first keystroke as a big jump.
	// So in window mode a focus opens a settle window: triggers are held until
	// one vv resize arrives (or a timeout when no resize comes — keyboard
	// already up / hardware keyboard), then a single check runs.

	it("defers the focus check until the keyboard-driven visualViewport resize", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		editor.fire("focus");
		expect(scrollBy).not.toHaveBeenCalled();
		vvFire("resize");
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});

	it("coalesces triggers during the settle window into the single post-settle check", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		editor.fire("focus");
		editor.fire("selectionUpdate");
		editor.fire("selectionUpdate");
		expect(scrollBy).not.toHaveBeenCalled();
		vvFire("resize");
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});

	it("falls back to a timeout when no viewport resize arrives", () => {
		vi.useFakeTimers();
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		editor.fire("focus");
		expect(scrollBy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(400);
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});

	it("disarms the one-shot resize listener after settling — later resizes never re-check", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		editor.fire("focus");
		vvFire("resize");
		expect(scrollBy).toHaveBeenCalledTimes(1);
		// URL-bar show/hide etc. — must not re-assert the caret into view.
		vvFire("resize");
		vvFire("resize");
		expect(scrollBy).toHaveBeenCalledTimes(1);
		expect(vvHandlers.get("resize")?.size ?? 0).toBe(0);
	});

	it("container mode (desktop, no keyboard) checks immediately on focus", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		const scroller = {
			getBoundingClientRect: () => ({ bottom: 800 }),
			scrollTop: 0,
		};
		editor.view.dom.parentElement = scroller;
		install(editor, { mode: "container" });
		editor.fire("focus");
		// limit = 800 - 60 - 8 = 732; caret 790 → overflow 58
		expect(scroller.scrollTop).toBe(58);
	});
});

describe("installCursorVisibility — update-trigger gate (background transactions)", () => {
	// editor 'update' fires for EVERY doc change, including background
	// dispatches (autolink rescan, chat streaming). Those never request
	// scrollIntoView; nudging on them yanks a reader who scrolled away from a
	// parked caret back down. Mirror ProseMirror's own convention: only
	// transactions that asked for scrollIntoView may trigger a nudge.

	it("ignores background doc updates that did not request scrollIntoView", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		editor.fire("update", { transaction: { scrolledIntoView: false } });
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("nudges on edits whose transaction requested scrollIntoView", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		install(editor, { mode: "window" });
		editor.fire("update", { transaction: { scrolledIntoView: true } });
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});
});

describe("shouldDeferScrollToSelection — PM scrollToSelection delegation", () => {
	// Replaces the static scrollMargin/scrollThreshold {bottom:60}: when this
	// returns true, PM skips its own scroll and installCursorVisibility (which
	// knows the real visual-viewport bottom incl. offsetTop and the live
	// toolbar height) owns the downward reveal. It must mirror check()'s own
	// guards so it never claims a scroll the module would then refuse.

	type ViewOpts = {
		focused?: boolean;
		empty?: boolean;
		top?: number;
		bottom?: number;
		scroller?: unknown;
	};
	function mkView({
		focused = true,
		empty = true,
		top = 100,
		bottom = 116,
		scroller = null,
	}: ViewOpts) {
		return {
			hasFocus: () => focused,
			coordsAtPos: () => ({ top, bottom, left: 0, right: 0 }),
			state: { selection: { head: 1, empty } },
			dom: { parentElement: scroller },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
	}

	it("returns false when the view is unfocused (PM keeps handling)", () => {
		expect(shouldDeferScrollToSelection(mkView({ focused: false }))).toBe(
			false,
		);
	});

	it("returns false for a range selection (mirrors the selection.empty guard)", () => {
		expect(shouldDeferScrollToSelection(mkView({ empty: false }))).toBe(false);
	});

	it("returns false when the caret is above the visible top (upward reveal stays with PM)", () => {
		vvStub.offsetTop = 50;
		expect(shouldDeferScrollToSelection(mkView({ top: 10, bottom: 26 }))).toBe(
			false,
		);
	});

	it("returns true for a collapsed caret at/below the visible area (module owns downward)", () => {
		expect(shouldDeferScrollToSelection(mkView({ top: 100 }))).toBe(true);
	});

	it("container mode compares against the scroller top", () => {
		const scroller = {
			getBoundingClientRect: () => ({ top: 60, bottom: 800 }),
		};
		expect(
			shouldDeferScrollToSelection(mkView({ top: 30, scroller }), "container"),
		).toBe(false);
		expect(
			shouldDeferScrollToSelection(mkView({ top: 100, scroller }), "container"),
		).toBe(true);
	});
});
