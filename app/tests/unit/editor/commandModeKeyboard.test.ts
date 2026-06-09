import { describe, expect, it, vi } from "vitest";
import { applyCommandModeKeyboard } from "$lib/editor/commandModeKeyboard";

// applyCommandModeKeyboard drives the keyboard-suppression policy behind the
// mobile "Ctrl 고정" / "Alt 고정" toolbar toggles. We fake just the slice of the
// ProseMirror view it touches (the contenteditable DOM node + hasFocus) so we
// can assert the attribute/blur policy without a browser layout engine.

function makeFakeView(focused: boolean) {
	const dom = document.createElement("div");
	const blur = vi.fn();
	dom.blur = blur;
	return {
		view: { dom, hasFocus: () => focused },
		dom,
		blur,
	};
}

describe("applyCommandModeKeyboard", () => {
	it('sets inputmode="none" when a lock is active so tapping does not raise the keyboard', () => {
		const { view, dom } = makeFakeView(false);
		applyCommandModeKeyboard(view, true);
		expect(dom.getAttribute("inputmode")).toBe("none");
	});

	it("removes inputmode when no lock is active (normal text keyboard restored)", () => {
		const { view, dom } = makeFakeView(false);
		dom.setAttribute("inputmode", "none");
		applyCommandModeKeyboard(view, false);
		expect(dom.hasAttribute("inputmode")).toBe(false);
	});

	it("blurs once when a lock turns on while the editor already holds focus (drops an open keyboard)", () => {
		const { view, blur } = makeFakeView(true);
		applyCommandModeKeyboard(view, true);
		expect(blur).toHaveBeenCalledTimes(1);
	});

	it("does NOT blur when locking while the editor is unfocused (nothing to dismiss)", () => {
		const { view, blur } = makeFakeView(false);
		applyCommandModeKeyboard(view, true);
		expect(blur).not.toHaveBeenCalled();
	});

	it("does not blur when unlocking", () => {
		const { view, blur } = makeFakeView(true);
		applyCommandModeKeyboard(view, false);
		expect(blur).not.toHaveBeenCalled();
	});
});
