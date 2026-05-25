import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { JSONContent } from '@tiptap/core';

import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(d: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem,
			...TomboyFootnote
		],
		content: d
	});
	currentEditor = editor;
	return editor;
}

function p(text: string): JSONContent {
	return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
}
function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

function paragraphTexts(editor: Editor): string[] {
	const out: string[] = [];
	editor.state.doc.forEach((node) => out.push(node.textContent));
	return out;
}

/**
 * Find absolute PM position of `needle` substring within the top-level
 * paragraph at index `paraIdx`. Returns the position of `needle[0]`.
 */
function findText(editor: Editor, paraIdx: number, needle: string): number {
	let paraStart = 0;
	editor.state.doc.forEach((_n, offset, i) => {
		if (i === paraIdx) paraStart = offset;
	});
	const text = editor.state.doc.child(paraIdx).textContent;
	const idx = text.indexOf(needle);
	if (idx < 0) throw new Error(`not found: ${needle}`);
	return paraStart + 1 + idx;
}

function deleteAt(editor: Editor, from: number, to: number): void {
	editor.view.dispatch(editor.state.tr.delete(from, to));
}

describe('footnote cleanup plugin', () => {
	// removed in Task 8 — cleanupPlugin no longer needed once markers are atomic nodes.
	it.skip("'['만 지우면 잔해 '^1]' 자동 제거", () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1] 끝'), p('---'), p('[^1] 설명'))
		);
		const lbra = findText(editor, 1, '[^1]');
		deleteAt(editor, lbra, lbra + 1);
		expect(paragraphTexts(editor)[1]).toBe('본문  끝');
	});

	// removed in Task 8 — cleanupPlugin no longer needed.
	it.skip("']'만 지우면 잔해 '[^1' 자동 제거", () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1] 끝'), p('---'), p('[^1] 설명'))
		);
		const rbra = findText(editor, 1, '[^1]') + 3;
		deleteAt(editor, rbra, rbra + 1);
		expect(paragraphTexts(editor)[1]).toBe('본문  끝');
	});

	// removed in Task 8 — cleanupPlugin no longer needed.
	it.skip("'^' 만 지우면 잔해 '[1]' 자동 제거", () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1] 끝'), p('---'), p('[^1] 설명'))
		);
		const caret = findText(editor, 1, '[^1]') + 1;
		deleteAt(editor, caret, caret + 1);
		expect(paragraphTexts(editor)[1]).toBe('본문  끝');
	});

	// removed in Task 8 — cleanupPlugin no longer needed.
	it.skip('라벨만 지우면 잔해 [^] 자동 제거', () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1] 끝'), p('---'), p('[^1] 설명'))
		);
		const lbl = findText(editor, 1, '[^1]') + 2;
		deleteAt(editor, lbl, lbl + 1);
		expect(paragraphTexts(editor)[1]).toBe('본문  끝');
	});

	it("마커 안에서 타이핑해 라벨이 길어진 경우 ([^1] → [^12]) — 손대지 않음", () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1] 끝'), p('---'), p('[^1] 설명'))
		);
		const beforeRbra = findText(editor, 1, '[^1]') + 3;
		editor.view.dispatch(editor.state.tr.insertText('2', beforeRbra));
		expect(paragraphTexts(editor)[1]).toBe('본문 [^12] 끝');
	});

	// removed in Task 8 — cleanupPlugin no longer needed.
	it.skip('한 단락에 마커 둘 — 망가진 것만 정리', () => {
		const editor = makeEditor(
			doc(p('제목'), p('A [^1] B [^2] C'), p('---'), p('[^1] 일'), p('[^2] 이'))
		);
		const lbra = findText(editor, 1, '[^1]');
		deleteAt(editor, lbra, lbra + 1);
		expect(paragraphTexts(editor)[1]).toBe('A  B [^2] C');
	});

	// removed in Task 8 — cleanupPlugin no longer needed.
	it.skip('정의 단락 마커 부분 삭제 — 잔해는 지우되 설명 텍스트는 보존', () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1]'), p('---'), p('[^1] 설명 내용'))
		);
		const defLbra = findText(editor, 3, '[^1]');
		deleteAt(editor, defLbra, defLbra + 1);
		expect(paragraphTexts(editor)[3]).toBe(' 설명 내용');
	});

	it('마커 전체 삭제 — 추가 정리 없음', () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1] 끝'), p('---'), p('[^1] 설명'))
		);
		const lbra = findText(editor, 1, '[^1]');
		deleteAt(editor, lbra, lbra + 4);
		expect(paragraphTexts(editor)[1]).toBe('본문  끝');
	});

	it('마커가 없는 doc — no-op (다른 입력 영향 없음)', () => {
		const editor = makeEditor(doc(p('제목'), p('본문')));
		const end = findText(editor, 1, '본문') + 2;
		editor.view.dispatch(editor.state.tr.insertText('!', end));
		expect(paragraphTexts(editor)[1]).toBe('본문!');
	});

	it("새로 타이핑한 부분 마커 '[^3' — 추적 대상 아님, 보존", () => {
		const editor = makeEditor(doc(p('제목'), p('본문')));
		const end = findText(editor, 1, '본문') + 2;
		editor.view.dispatch(editor.state.tr.insertText('[^3', end));
		expect(paragraphTexts(editor)[1]).toBe('본문[^3');
	});

	it('두 마커의 잔해가 합쳐 우연히 valid 패턴이 되면 — 정리 안 함', () => {
		// 본문 `[^1] X [^2]` 에서 첫 '^' 부터 둘 '^' 직전까지를 한 번에 지움.
		// 남은 텍스트: `[` (첫) + `^2]` (둘) = `[^2]` — valid 마커. 우리는
		// 이를 의도된 valid 마커로 간주하고 손대지 않는다.
		const editor = makeEditor(
			doc(p('제목'), p('[^1] X [^2]'), p('---'), p('[^1] 일'), p('[^2] 이'))
		);
		const firstCaret = findText(editor, 1, '[^1]') + 1;
		const secondCaret = findText(editor, 1, '[^2]') + 1;
		deleteAt(editor, firstCaret, secondCaret);
		expect(paragraphTexts(editor)[1]).toBe('[^2]');
	});

	// removed in Task 8 — cleanupPlugin no longer needed.
	it.skip('두 마커가 각각 다른 트랜잭션으로 망가지면 — 각각 정리', () => {
		const editor = makeEditor(
			doc(p('제목'), p('A [^1] B [^2] C'), p('---'), p('[^1] 일'), p('[^2] 이'))
		);
		// 첫 마커의 ']' 만 지움 → '[^1' 잔해
		const firstRbra = findText(editor, 1, '[^1]') + 3;
		deleteAt(editor, firstRbra, firstRbra + 1);
		expect(paragraphTexts(editor)[1]).toBe('A  B [^2] C');
		// 다음 트랜잭션에서 둘째 마커의 '^' 지움 → '[2]' 잔해
		const secondCaret = findText(editor, 1, '[^2]') + 1;
		deleteAt(editor, secondCaret, secondCaret + 1);
		expect(paragraphTexts(editor)[1]).toBe('A  B  C');
	});
});
