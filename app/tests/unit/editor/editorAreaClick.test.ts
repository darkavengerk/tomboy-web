import { beforeEach, describe, expect, it } from "vitest";
import { isEditorAreaWhitespaceClick } from "$lib/editor/editorAreaClick";

// The mobile note route focuses the caret at the END of the document when the
// user taps "whitespace" in .editor-area (short notes leave a big empty strip
// below the content). TipTap's focus() scrolls the selection into view by
// default, so a misclassified tap = a jump to the document end. The bars
// mounted inside .editor-area (MusicPlayerBar / ChatSendBar /
// RemarkableActionBar) and the find bar do NOT stopPropagation — their taps
// bubble into the area handler and must be excluded here.

function buildArea(): HTMLElement {
	document.body.innerHTML = `
		<div class="editor-area">
			<div class="music-bar">
				<div class="music-now"><b>곡 제목</b></div>
				<button class="play">▶</button>
			</div>
			<div class="tomboy-editor-shell">
				<div class="find-bar-slot"><input /></div>
				<div class="tomboy-editor"><div class="tiptap"><p>본문</p></div></div>
			</div>
			<div class="llm-send-bar"><button class="send">전송</button></div>
			<div class="rm-bar"><span class="rm-title">리마커블</span></div>
			<div class="plain-whitespace"></div>
		</div>`;
	return document.querySelector(".editor-area") as HTMLElement;
}

function q(sel: string): Element {
	const el = document.querySelector(sel);
	if (!el) throw new Error(`missing ${sel}`);
	return el;
}

describe("isEditorAreaWhitespaceClick", () => {
	beforeEach(() => {
		buildArea();
	});

	it("rejects clicks inside the contenteditable (.tiptap) — native caret placement wins", () => {
		expect(isEditorAreaWhitespaceClick(q(".tiptap p"))).toBe(false);
	});

	it("rejects clicks on buttons bubbling from the bars (music play etc.)", () => {
		expect(isEditorAreaWhitespaceClick(q(".music-bar .play"))).toBe(false);
		expect(isEditorAreaWhitespaceClick(q(".llm-send-bar .send"))).toBe(false);
	});

	it("rejects clicks on bar backgrounds (non-button padding inside the bars)", () => {
		expect(isEditorAreaWhitespaceClick(q(".music-now"))).toBe(false);
		expect(isEditorAreaWhitespaceClick(q(".rm-title"))).toBe(false);
	});

	it("rejects clicks in the find bar (would steal focus from its input)", () => {
		expect(isEditorAreaWhitespaceClick(q(".find-bar-slot"))).toBe(false);
		expect(isEditorAreaWhitespaceClick(q(".find-bar-slot input"))).toBe(false);
	});

	it("accepts clicks on genuine whitespace (the focus-at-end affordance)", () => {
		expect(isEditorAreaWhitespaceClick(q(".plain-whitespace"))).toBe(true);
		expect(isEditorAreaWhitespaceClick(q(".editor-area"))).toBe(true);
	});

	it("rejects a null target", () => {
		expect(isEditorAreaWhitespaceClick(null)).toBe(false);
	});
});
