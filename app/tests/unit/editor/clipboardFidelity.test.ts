import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyDatetime } from '$lib/editor/extensions/TomboyDatetime.js';
import { FootnoteMarker } from '$lib/editor/footnote/node.js';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import {
	ClipboardFidelity,
	buildClipboardParser,
	parsePlainTextLines
} from '$lib/editor/clipboardFidelity.js';
import {
	handleClipboardCopy,
	buildClipboardHtml,
	copySelectionSlice,
	TOMBOY_SLICE_ATTR
} from '$lib/editor/clipboardPlainText.js';
import type { JSONContent } from '@tiptap/core';

const editors: Editor[] = [];

afterEach(() => {
	for (const e of editors) e.destroy();
	editors.length = 0;
});

function makeEditor(doc: JSONContent): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false,
				horizontalRule: false
			}),
			TomboyParagraph,
			TomboyListItem,
			TomboyDatetime,
			FootnoteMarker,
			...TomboyInlineCheckbox,
			ClipboardFidelity
		],
		content: doc,
		editorProps: {
			handleDOMEvents: {
				copy: handleClipboardCopy
			}
		}
	});
	editors.push(editor);
	return editor;
}

/** jsdom 합성 copy 이벤트 + DataTransfer 스텁 (clipboardPlainText.test.ts 와 동일 하니스). */
function dispatchCopy(editor: Editor): { text: string; html: string } {
	const data: Record<string, string> = {};
	const clipboardData = {
		setData(k: string, v: string) {
			data[k] = v;
		},
		getData(k: string) {
			return data[k] ?? '';
		},
		clearData() {
			for (const k of Object.keys(data)) delete data[k];
		}
	};
	const event = new Event('copy', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clipboardData', { value: clipboardData });
	editor.view.dom.dispatchEvent(event);
	return { text: data['text/plain'] ?? '', html: data['text/html'] ?? '' };
}

const pasteEvent = () => new Event('paste') as ClipboardEvent;

function docJson(...children: JSONContent[]): JSONContent {
	return { type: 'doc', content: children };
}
function p(...content: JSONContent[]): JSONContent {
	return { type: 'paragraph', content };
}
function t(text: string, marks?: JSONContent['marks']): JSONContent {
	return marks ? { type: 'text', text, marks } : { type: 'text', text };
}
/** JSONContent 유니온에서 text 필드 안전 추출 (TipTap 3 타입은 text 노드를 좁혀주지 않는다). */
function textOf(n: unknown): string | undefined {
	return (n as { text?: string } | undefined)?.text;
}

/** 플러그인 atom + 마크 + 빈 줄을 모두 포함한 대표 문서. */
const RICH_DOC = docJson(
	p(t('제목 줄')),
	p(
		t('굵게', [{ type: 'bold' }]),
		t(' 와 각주'),
		{ type: 'footnoteMarker', attrs: { label: '1' } },
		t(' 그리고 체크박스 '),
		{ type: 'inlineCheckbox', attrs: { checked: true } }
	),
	p(),
	p(t('2026-06-11', [{ type: 'tomboyDatetime' }]), t(' 마지막 줄'))
);

describe('노트→노트 정확 복원 (data-tomboy-slice)', () => {
	it('copy 가 text/html 에 data-tomboy-slice + data-pm-slice 를 싣는다', () => {
		const a = makeEditor(RICH_DOC);
		a.commands.selectAll();
		const { html } = dispatchCopy(a);
		expect(html).toContain(TOMBOY_SLICE_ATTR);
		// PM 의 sliceData 정규식 /^(\d+) (\d+)(?: -(\d+))? (.*)/ 에 맞는 형식.
		expect(html).toMatch(/data-pm-slice="\d+ \d+ \[\]"/);
	});

	it('copy → paste 라운드트립이 atom·마크·빈 paragraph 를 그대로 보존한다', () => {
		const a = makeEditor(RICH_DOC);
		a.commands.selectAll();
		const { html } = dispatchCopy(a);

		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteHTML(html, pasteEvent());

		expect(b.getJSON()).toEqual(a.getJSON());
	});

	it('체크박스 atom 이 텍스트가 아니라 노드로 붙는다 (회귀 가드)', () => {
		const a = makeEditor(RICH_DOC);
		a.commands.selectAll();
		const { html } = dispatchCopy(a);

		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteHTML(html, pasteEvent());

		const types: string[] = [];
		b.state.doc.descendants((node) => {
			types.push(node.type.name);
		});
		expect(types).toContain('inlineCheckbox');
		expect(types).toContain('footnoteMarker');
	});

	it('payload 가 깨지면 조용히 HTML 파싱으로 폴백한다', () => {
		const a = makeEditor(docJson(p(t('x'))));
		const parser = buildClipboardParser(a.schema);
		const dom = document.createElement('div');
		dom.innerHTML = `<div ${TOMBOY_SLICE_ATTR}="{broken json"><p>hi</p></div>`;
		const slice = parser.parseSlice(dom);
		expect(slice.content.textBetween(0, slice.content.size)).toBe('hi');
	});

	it('payload 없는 외부 HTML 은 기존 파싱 그대로 동작한다', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteHTML('<p>외부 <strong>굵게</strong></p>', pasteEvent());
		const json = b.getJSON();
		const firstPara = json.content?.[0];
		expect(firstPara?.type).toBe('paragraph');
		const boldRun = firstPara?.content?.find((c) =>
			(c.marks ?? []).some((m) => m.type === 'bold')
		);
		expect(textOf(boldRun)).toBe('굵게');
	});

	it('buildClipboardHtml 은 따옴표가 든 JSON 을 속성으로 안전하게 이스케이프한다', () => {
		const a = makeEditor(docJson(p(t('따옴표 "안" & <태그>'))));
		a.commands.selectAll();
		const html = buildClipboardHtml(copySelectionSlice(a.state), a.getJSON());
		const dom = document.createElement('div');
		dom.innerHTML = html;
		const el = dom.querySelector(`[${TOMBOY_SLICE_ATTR}]`);
		const raw = el?.getAttribute(TOMBOY_SLICE_ATTR);
		expect(raw).toBeTruthy();
		expect(() => JSON.parse(raw!)).not.toThrow();
	});
});

describe('plain 붙여넣기 빈 줄 보존 (clipboardTextParser)', () => {
	it('a\\n\\nb 가 paragraph 3개(가운데 빈 줄)로 붙는다', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('a\n\nb', pasteEvent());
		const blocks = b.getJSON().content ?? [];
		expect(blocks).toHaveLength(3);
		expect(textOf(blocks[0].content?.[0])).toBe('a');
		expect(blocks[1].content ?? []).toHaveLength(0);
		expect(textOf(blocks[2].content?.[0])).toBe('b');
	});

	it('연속 빈 줄도 줄 수 그대로 살아남는다', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('a\n\n\nb', pasteEvent());
		const blocks = b.getJSON().content ?? [];
		expect(blocks).toHaveLength(4);
	});

	it('CRLF 도 같은 결과를 낸다', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('a\r\n\r\nb', pasteEvent());
		expect(b.getJSON().content ?? []).toHaveLength(3);
	});

	it('plain 붙여넣기에서 [x] 마커는 여전히 atom 으로 재조립된다 (transformPasted 회귀 가드)', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('[x] 할 일\n\n[^2] 각주', pasteEvent());
		const types: string[] = [];
		b.state.doc.descendants((node) => {
			types.push(node.type.name);
		});
		expect(types).toContain('inlineCheckbox');
		expect(types).toContain('footnoteMarker');
	});

	it('parsePlainTextLines 가 컨텍스트 마크를 텍스트에 전달한다', () => {
		const b = makeEditor(docJson(p(t('굵은 문장', [{ type: 'bold' }]))));
		// 굵은 텍스트 안에 캐럿 — $context.marks() 가 bold 를 돌려준다.
		b.commands.setTextSelection(3);
		const $ctx = b.state.selection.$from;
		const slice = parsePlainTextLines('x', $ctx, b.view);
		const firstChild = slice.content.firstChild?.firstChild;
		expect(firstChild?.marks.some((m) => m.type.name === 'bold')).toBe(true);
	});
});

describe('plain 붙여넣기 마크다운 불릿 인식 (clipboardTextParser)', () => {
	/** 첫 bulletList 블록을 찾아 각 항목의 첫 줄 텍스트를 뽑는다. */
	function bulletTexts(json: JSONContent): string[] {
		const list = (json.content ?? []).find((b) => b.type === 'bulletList');
		return (list?.content ?? []).map((li) => textOf(li.content?.[0]?.content?.[0]) ?? '');
	}

	it('연속한 `- ` 줄이 bulletList 한 개로 묶인다', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('- 사과\n- 바나나\n- 포도', pasteEvent());
		const blocks = b.getJSON().content ?? [];
		const lists = blocks.filter((n) => n.type === 'bulletList');
		expect(lists).toHaveLength(1);
		expect(lists[0].content).toHaveLength(3);
		expect(bulletTexts(b.getJSON())).toEqual(['사과', '바나나', '포도']);
	});

	it('`* ` 와 `+ ` 마커도 불릿으로 인식한다 (타이핑 규칙과 동일)', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('* 별\n+ 더하기', pasteEvent());
		expect(bulletTexts(b.getJSON())).toEqual(['별', '더하기']);
	});

	it('들여쓰기가 중첩 bulletList 로 변환된다', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('- 상위\n  - 하위\n- 둘째', pasteEvent());
		const list = (b.getJSON().content ?? []).find((n) => n.type === 'bulletList');
		expect(list?.content).toHaveLength(2); // 상위(중첩 보유) + 둘째
		// 라이브 PM 문서로 중첩 구조 검증 (JSONContent 깊은 탐색 회피).
		let bulletLists = 0;
		const texts: string[] = [];
		b.state.doc.descendants((node) => {
			if (node.type.name === 'bulletList') bulletLists++;
			if (node.isText && node.text) texts.push(node.text);
		});
		expect(bulletLists).toBe(2); // 바깥 + 중첩
		expect(texts).toEqual(expect.arrayContaining(['상위', '하위', '둘째']));
	});

	it('불릿 아닌 줄은 그대로 paragraph 로 남는다 (혼합)', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('머리말\n- 항목\n맺음말', pasteEvent());
		const blocks = b.getJSON().content ?? [];
		expect(blocks.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'paragraph']);
		expect(textOf(blocks[0].content?.[0])).toBe('머리말');
		expect(textOf(blocks[2].content?.[0])).toBe('맺음말');
	});

	it('마커 뒤 공백이 없으면 불릿이 아니다 (`-5도`)', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('-5도', pasteEvent());
		const blocks = b.getJSON().content ?? [];
		expect(blocks.map((n) => n.type)).toEqual(['paragraph']);
		expect(textOf(blocks[0].content?.[0])).toBe('-5도');
	});

	it('불릿 항목 안 [x] 마커는 체크박스 atom 으로 재조립된다 (transformPasted)', () => {
		const b = makeEditor(docJson(p()));
		b.commands.selectAll();
		b.view.pasteText('- [x] 끝낸 일\n- [ ] 할 일', pasteEvent());
		const types: string[] = [];
		b.state.doc.descendants((node) => {
			types.push(node.type.name);
		});
		expect(types).toContain('bulletList');
		expect(types).toContain('inlineCheckbox');
	});
});

describe('순서 리스트 비활성화 (1. 입력 무시)', () => {
	it('orderedList 노드를 빼면 스키마에 없고 input rule 도 사라진다', () => {
		const e = new Editor({
			extensions: [
				StarterKit.configure({
					code: false,
					codeBlock: false,
					paragraph: false,
					listItem: false,
					horizontalRule: false,
					orderedList: false
				}),
				TomboyParagraph,
				TomboyListItem
			],
			content: docJson(p())
		});
		editors.push(e);
		expect(e.schema.nodes.orderedList).toBeUndefined();
		expect(e.schema.nodes.bulletList).toBeTruthy();
	});
});
