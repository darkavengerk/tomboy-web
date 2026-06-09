import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCursorVisibility } from "$lib/editor/keepCursorVisible";

// installCursorVisibility relies on layout APIs jsdom doesn't implement
// (coordsAtPos returns real geometry only with a browser layout engine, and
// there is no visualViewport). We fake just the surface the module touches so
// we can assert its scroll *policy* — specifically that it leaves native
// text-selection scrolling alone.

type FakeOpts = { empty: boolean; caretBottom: number; focused?: boolean };

function makeFakeEditor({ empty, caretBottom, focused = true }: FakeOpts) {
	const listeners = new Map<string, Array<() => void>>();
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
		dom: { parentElement: null },
	};
	return {
		// only the members installCursorVisibility reads
		view,
		on(event: string, cb: () => void) {
			const arr = listeners.get(event) ?? [];
			arr.push(cb);
			listeners.set(event, arr);
		},
		off() {},
		fire(event: string) {
			for (const cb of listeners.get(event) ?? []) cb();
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

let scrollBy: ReturnType<typeof vi.fn>;
let vvListeners: string[];

beforeEach(() => {
	scrollBy = vi.fn();
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
			name === "--toolbar-height" ? "60px" : "",
	}));
	vvListeners = [];
	const vv = {
		offsetTop: 0,
		height: 800,
		addEventListener: (type: string) => vvListeners.push(type),
		removeEventListener: () => {},
	};
	vi.stubGlobal("visualViewport", vv);
	(window as unknown as { visualViewport: unknown }).visualViewport = vv;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("installCursorVisibility — selection-mode regression", () => {
	it("scrolls a collapsed caret that sits under the toolbar (typing case)", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		installCursorVisibility(editor, { mode: "window" });
		editor.fire("selectionUpdate");
		expect(scrollBy).toHaveBeenCalledTimes(1);
		expect(scrollBy).toHaveBeenCalledWith({ top: 58, left: 0 });
	});

	it("does NOT scroll during a non-empty range selection (text-selection mode)", () => {
		const editor = makeFakeEditor({ empty: false, caretBottom: 790 });
		installCursorVisibility(editor, { mode: "window" });
		// Mobile long-press fires a stream of selectionchange events as the OS
		// drives its own auto-scroll; we must not fight it.
		editor.fire("selectionUpdate");
		editor.fire("selectionUpdate");
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does not scroll a collapsed caret already above the toolbar", () => {
		const editor = makeFakeEditor({ empty: true, caretBottom: 400 });
		installCursorVisibility(editor, { mode: "window" });
		editor.fire("selectionUpdate");
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does NOT subscribe to visualViewport scroll/resize (would fight the user's own scrolling)", () => {
		// A viewport scroll never moves the caret. Re-asserting the caret into
		// view on every scroll tick traps the user at the caret — scrolling up
		// (keyboard open) snaps back down, and selection drags oscillate against
		// the OS auto-scroll. The feature must be edit-driven only.
		const editor = makeFakeEditor({ empty: true, caretBottom: 790 });
		installCursorVisibility(editor, { mode: "window" });
		expect(vvListeners).not.toContain("scroll");
		expect(vvListeners).not.toContain("resize");
	});
});
