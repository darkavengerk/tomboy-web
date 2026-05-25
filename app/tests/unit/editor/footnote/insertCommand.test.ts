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
			...TomboyFootnote
		],
		content: d
	});
	currentEditor = editor;
	return editor;
}

/**
 * 텍스트 안의 `[^N]` 토큰을 footnoteMarker 노드로 변환해서 paragraph content
 * 를 빌드한다. Task 6 부터 마커는 atomic 노드라 input rule 없이 JSONContent
 * 단계에서 직접 노드를 박아야 한다. (Task 7 에서 input rule + paste transform
 * 도입 후에는 텍스트만 줘도 되지만, 이 테스트는 그 전 단계의 단위 테스트.)
 */
const FOOTNOTE_TOKEN_RE = /\[\^([^\]\s]+)\]/g;
function p(text: string): JSONContent {
	if (!text) return { type: 'paragraph', content: [] };
	const content: JSONContent[] = [];
	let last = 0;
	FOOTNOTE_TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FOOTNOTE_TOKEN_RE.exec(text)) !== null) {
		if (m.index > last) {
			content.push({ type: 'text', text: text.slice(last, m.index) });
		}
		content.push({ type: 'footnoteMarker', attrs: { label: m[1] } });
		last = m.index + m[0].length;
	}
	if (content.length === 0) {
		return { type: 'paragraph', content: [{ type: 'text', text }] };
	}
	if (last < text.length) {
		content.push({ type: 'text', text: text.slice(last) });
	}
	return { type: 'paragraph', content };
}

function doc(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}

/**
 * Place the cursor at character offset `charOffset` within the textblock
 * at top-level index `paraIndex`. Counts atomic footnoteMarker nodes as
 * 1 "char" (matches PM's position math) so test offsets stay readable.
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

/**
 * footnoteMarker 노드를 `[^N]` 로 렌더링해 paragraph 텍스트를 만든다.
 * 노드 시대에는 `textContent` 가 label 만 뱉어서 (`'1'`) 가독성이 떨어지므로
 * 테스트 비교용 텍스트로 풀어 쓴다.
 */
function nodeToPlain(node: import('@tiptap/pm/model').Node): string {
	if (node.isText) return node.text ?? '';
	if (node.type.name === 'footnoteMarker') {
		return `[^${node.attrs.label ?? ''}]`;
	}
	let out = '';
	node.forEach((child) => {
		out += nodeToPlain(child);
	});
	return out;
}

function paragraphTexts(editor: Editor): string[] {
	const out: string[] = [];
	editor.state.doc.forEach((node) => {
		out.push(nodeToPlain(node));
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
		// '본문 [^1] 이어서' 텍스트에서 [^1] 은 atomic 노드 = 1 char.
		// 길이: '본문 ' (3) + [^1] (1) + ' 이어서' (4) = 8
		setCursor(editor, 1, 8);

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
		// [^1](1) + space(1) + 와(1) = 3 — 'wa' 바로 뒤, [^2] 위치(start+5)
		// 바로 앞은 [^2].from 이라 inside-marker 가드에 잡힌다. atomic 마커는
		// "사이" 가 단일 점이라 다른 점 — 와 뒤로 — 에 커서를 둔다.
		setCursor(editor, 1, 3);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// NEW 가 '와' 뒤, 기존 [^2] 앞에 끼어들어 라벨 2 를 가져간다.
		// 기존 [^2] 는 라벨 3 으로 밀린다.
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^1] 와[^2] [^3] 사이',
			'---',
			'[^1] 일',
			'[^2] ',
			'[^3] 이'
		]);
	});

	it('같은 라벨 다중 참조 — 한 그룹으로 묶여 함께 리넘버', () => {
		const editor = makeEditor(
			doc(p('제목'), p('[^1] 본문 [^2] 또 [^1]'), p('---'), p('[^1] 일'), p('[^2] 이'))
		);
		// '[^1] 본문 [^2] 또 [^1]' = 1+4+1+3+1 = 10
		setCursor(editor, 1, 10);

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
		// '[^abc] 와 [^1] 와 [^foo]' = 1+3+1+3+1 = 9
		setCursor(editor, 1, 9);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// 숫자 그룹: '1' 첫 등장 ('[^abc] 와 ' 뒤) → new '1'. __NEW__ 끝 → new '2'.
		// 정의 단락은 라벨 숫자 오름차순으로 재정렬, 비숫자는 뒤로 (상대 순서 유지).
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^abc] 와 [^1] 와 [^foo][^2]',
			'---',
			'[^1] 일',
			'[^2] ',
			'[^abc] a',
			'[^foo] f'
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

	it('커서가 기존 [^N] 노드 위치 (pos === marker.from) → abort with reason "inside-existing-marker"', () => {
		const editor = makeEditor(doc(p('제목'), p('a [^1] b'), p('---'), p('[^1] 일')));
		// 'a ' (2) + 마커 자리 — pos === marker.from. atomic 노드라 "안" 이
		// 곧 그 자리 한 점.
		setCursor(editor, 1, 2);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('inside-existing-marker');
	});

	it('마커 직후 (pos === marker.to) 는 허용 — 마커 바로 뒤에 새 참조 삽입', () => {
		const editor = makeEditor(doc(p('제목'), p('a [^1] b'), p('---'), p('[^1] 일')));
		// 'a ' (2) + [^1] (1) = 3 → 마커 바로 뒤.
		setCursor(editor, 1, 3);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		// 커서가 기존 마커 뒤 → 새 참조가 기존 뒤에 와서 라벨 2.
		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'a [^1][^2] b',
			'---',
			'[^1] 일',
			'[^2] '
		]);
	});

	it('마커 경계 (pos === marker.to) — 첫 그룹이 아닌 마커 위치면 새 ref 가 그 슬롯을 차지', () => {
		// 본문에 [^1], [^2] 두 그룹. 커서를 [^2] 직후에 두면 새 ref 가
		// 그 슬롯 다음에 들어가고 라벨 3 을 가져간다 — 정렬 후 doc 순서:
		// 기존[^1], 기존[^2], NEW.
		const editor = makeEditor(
			doc(p('제목'), p('[^1] 와 [^2] 사이'), p('---'), p('[^1] 일'), p('[^2] 이'))
		);
		// '[^1] 와 [^2]' = 1+3+1 = 5
		setCursor(editor, 1, 5);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^1] 와 [^2][^3] 사이',
			'---',
			'[^1] 일',
			'[^2] 이',
			'[^3] '
		]);
	});

	it('정의 단락은 새 라벨 순서대로 재정렬 — 작성 순서(creation order)가 아닌 라벨 순서', () => {
		// 사용자 보고된 버그: 본문에서 [^1] [^2] [^3] 순으로 보이는데 하단
		// 설명이 작성 시점 순서 (예: 2, 3, 1) 로 남아있던 케이스. 새 ref 를
		// 본문 끝에 하나 더 삽입해서 트리거하고, 모든 정의가 1..N 순서로
		// 재배치되는지 확인.
		const editor = makeEditor(
			doc(
				p('제목'),
				p('본문 [^1] 그리고 [^2] 그리고 [^3]'),
				p('---'),
				p('[^2] 두번째 만들어짐'),
				p('[^3] 세번째 만들어짐'),
				p('[^1] 마지막에 만들어짐')
			)
		);
		// '본문 [^1] 그리고 [^2] 그리고 [^3]' = 본+문+space+[^1]+space+그+리+고+space+[^2]+space+그+리+고+space+[^3] = 16
		setCursor(editor, 1, 16);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'본문 [^1] 그리고 [^2] 그리고 [^3][^4]',
			'---',
			'[^1] 마지막에 만들어짐',
			'[^2] 두번째 만들어짐',
			'[^3] 세번째 만들어짐',
			'[^4] '
		]);
	});

	it('새 정의가 정렬 후 중간에 끼어들 때도 커서가 그 단락 끝으로 이동', () => {
		// 본문 맨 앞에 새 ref 삽입 → 새 라벨 = 1, 기존이 2/3/4 로 밀림.
		// 새 정의 단락은 def-섹션의 첫 자리로 배치됨 (마지막이 아님).
		const editor = makeEditor(
			doc(
				p('제목'),
				p('본문 [^1] 그리고 [^2] 그리고 [^3]'),
				p('---'),
				p('[^1] 일'),
				p('[^2] 이'),
				p('[^3] 삼')
			)
		);
		setCursor(editor, 1, 0);

		const result = buildInsertFootnoteTransaction(editor.state);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		editor.view.dispatch(result.tr);

		expect(paragraphTexts(editor)).toEqual([
			'제목',
			'[^1]본문 [^2] 그리고 [^3] 그리고 [^4]',
			'---',
			'[^1] ',
			'[^2] 일',
			'[^3] 이',
			'[^4] 삼'
		]);

		// 커서는 새 정의 [^1]  (= 마지막이 아닌, def-섹션의 첫 자리) 끝에 있어야 함.
		const sel = editor.state.selection;
		// 새 정의 단락 내용 = [footnoteMarker(atom, no text children), text(' ')]
		// → textContent 는 atomic 노드를 건너뛰고 ' ' 만 뽑는다.
		expect(sel.$from.parent.textContent).toBe(' ');
		// 첫 inline 자식이 footnoteMarker(label='1') 이고, 뒤에 공백 텍스트.
		expect(sel.$from.parent.firstChild?.type.name).toBe('footnoteMarker');
		expect(sel.$from.parent.firstChild?.attrs.label).toBe('1');
		// 단락 시작(start)부터 [^1](1) + ' '(1) = 2.
		expect(sel.from).toBe(sel.$from.start() + 2);
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
		// 마지막 단락 = [footnoteMarker(atom, no text children), text(' ')]
		// → textContent 는 atomic 노드를 건너뛰고 ' ' 만 뽑는다.
		expect(lastPara.textContent).toBe(' ');
		// 첫 inline 자식이 footnoteMarker 이고, 라벨은 '1'.
		expect(lastPara.firstChild?.type.name).toBe('footnoteMarker');
		expect(lastPara.firstChild?.attrs.label).toBe('1');
	});
});
