import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import type { JSONContent } from '@tiptap/core';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyFootnote } from '$lib/editor/footnote/index.js';
import { buildInsertFootnoteTransaction } from '$lib/editor/footnote/insertCommand.js';

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
			TomboyFootnote
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

/**
 * Place the cursor at character offset `charOffset` within the textblock
 * at top-level index `paraIndex`.
 */
function setCursor(editor: Editor, paraIndex: number, charOffset: number): number {
	let absStart = 0;
	editor.state.doc.forEach((_n, offset, i) => {
		if (i === paraIndex) absStart = offset;
	});
	const pos = absStart + 1 + charOffset;
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos)))
	);
	return pos;
}

function paragraphTexts(editor: Editor): string[] {
	const out: string[] = [];
	editor.state.doc.forEach((node) => {
		out.push(node.textContent);
	});
	return out;
}

describe('buildInsertFootnoteTransaction', () => {
	it('빈 문서 — 첫 각주는 --- + [^1] 정의 단락 추가', () => {
		const editor = makeEditor(doc(p('제목'), p('')));
		setCursor(editor, 1, 0);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual(['제목', '[^1]', '---', '[^1] ']);
	});

	it('기존 각주 있으면 --- 안 만들고 정의 단락만 append', () => {
		const editor = makeEditor(
			doc(p('제목'), p('본문 [^1] 이어서'), p('---'), p('[^1] 기존 설명'))
		);
		setCursor(editor, 1, '본문 [^1] 이어서'.length);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'본문 [^1] 이어서[^2]',
			'---',
			'[^1] 기존 설명',
			'[^2] '
		]);
	});

	it('중간 삽입 — 라벨 시퀀스 재계산 ([^1] [^2] 사이에 새 참조 → 새는 [^2], 기존 [^2]는 [^3])', () => {
		const editor = makeEditor(
			doc(
				p('제목'),
				p('[^1] 와 [^2] 사이'),
				p('---'),
				p('[^1] 일'),
				p('[^2] 이')
			)
		);
		// 커서를 '[^1] 와 ' 다음 (char offset = '[^1] 와 '.length)
		setCursor(editor, 1, '[^1] 와 '.length);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^1] 와 [^2][^3] 사이',
			'---',
			'[^1] 일',
			'[^3] 이',
			'[^2] '
		]);
	});

	it('같은 라벨 다중 참조 — 한 그룹으로 묶여 함께 리넘버', () => {
		const editor = makeEditor(
			doc(p('제목'), p('[^1] 본문 [^2] 또 [^1]'), p('---'), p('[^1] 일'), p('[^2] 이'))
		);
		setCursor(editor, 1, '[^1] 본문 [^2] 또 [^1]'.length);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// 그룹 '1' 첫 등장 = 본문 시작 → new '1' (둘 다 [^1] 유지)
		// 그룹 '2' 첫 등장 = '본문 ' 뒤 → new '2'
		// __NEW__ 첫 등장 = 커서(끝) → new '3'
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^1] 본문 [^2] 또 [^1][^3]',
			'---',
			'[^1] 일',
			'[^2] 이',
			'[^3] '
		]);
	});

	it('비숫자 라벨 보존 — [^abc] 는 건드리지 않고 숫자만 리넘버', () => {
		const editor = makeEditor(
			doc(p('제목'), p('[^abc] 와 [^1] 와 [^foo]'), p('---'), p('[^abc] a'), p('[^1] 일'), p('[^foo] f'))
		);
		setCursor(editor, 1, '[^abc] 와 [^1] 와 [^foo]'.length);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// 숫자 그룹: '1' 첫 등장 ('[^abc] 와 ' 뒤) → new '1'. __NEW__ 끝 → new '2'.
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^abc] 와 [^1] 와 [^foo][^2]',
			'---',
			'[^abc] a',
			'[^1] 일',
			'[^foo] f',
			'[^2] '
		]);
	});

	it('커서가 제목(0번 단락) 안 → abort with reason "in-title"', () => {
		const editor = makeEditor(doc(p('제목'), p('본문')));
		setCursor(editor, 0, 2);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('in-title');
	});

	it('커서가 기존 [^N] 안 (strictly inside) → abort with reason "inside-existing-marker"', () => {
		const editor = makeEditor(doc(p('제목'), p('a [^1] b'), p('---'), p('[^1] 일')));
		// "[^1]" 의 '1' 앞 — char offset 4
		setCursor(editor, 1, 4);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('inside-existing-marker');
	});

	it('마커 경계 (pos === from) 는 허용 — 마커 바로 앞에 새 참조 삽입', () => {
		const editor = makeEditor(doc(p('제목'), p('a [^1] b'), p('---'), p('[^1] 일')));
		// "[^1]" 의 '[' 앞 — char offset 2
		setCursor(editor, 1, 2);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// 커서가 '[' 경계 = 첫 (유일한) 그룹 위치 → 기존이 라벨 1, 새 ref 가 라벨 2.
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'a [^2][^1] b',
			'---',
			'[^1] 일',
			'[^2] '
		]);
	});

	it('마커 경계 (pos === from) — 첫 그룹이 아닌 마커 위치면 새 ref 가 그 슬롯을 차지', () => {
		// 본문에 [^1], [^2] 두 그룹. 커서를 [^2] 의 '[' 위치에 두면 새 ref 가
		// 그 슬롯에 끼어들어 라벨 2 를 가져가고, 기존 [^2] 는 [^3] 로 밀린다
		// (ordered-list 시맨틱 — 삽입 후 doc 순서: [^1], NEW, 기존[^2]).
		const editor = makeEditor(
			doc(p('제목'), p('[^1] 와 [^2] 사이'), p('---'), p('[^1] 일'), p('[^2] 이'))
		);
		setCursor(editor, 1, '[^1] 와 '.length); // = '[^2]' 의 '[' 위치

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^1] 와 [^2][^3] 사이',
			'---',
			'[^1] 일',
			'[^3] 이',
			'[^2] '
		]);
	});

	it('셀렉션 영역 (from !== to) → 셀렉션을 새 참조로 대체', () => {
		const editor = makeEditor(doc(p('제목'), p('hello world')));
		let absStart = 0;
		editor.state.doc.forEach((_n, offset, i) => {
			if (i === 1) absStart = offset;
		});
		// "hello" 선택 (5글자)
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, absStart + 1, absStart + 1 + 5)
			)
		);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual(['제목', '[^1] world', '---', '[^1] ']);
	});

	it('커서가 새 정의 단락 끝 ([^N] 의 공백 뒤) 로 이동', () => {
		const editor = makeEditor(doc(p('제목'), p('본문')));
		setCursor(editor, 1, 2);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		const sel = editor.state.selection;
		const lastPara = editor.state.doc.lastChild!;
		const lastParaTextEnd = editor.state.doc.content.size - 1;
		expect(sel.from).toBe(lastParaTextEnd);
		expect(sel.$from.parent).toBe(lastPara);
		expect(lastPara.textContent).toBe('[^1] ');
	});
});
