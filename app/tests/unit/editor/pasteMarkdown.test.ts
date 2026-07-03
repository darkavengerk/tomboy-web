import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboySize } from '$lib/editor/extensions/TomboySize.js';
import { FootnoteMarker } from '$lib/editor/footnote/node.js';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { ClipboardFidelity } from '$lib/editor/clipboardFidelity.js';
import type { JSONContent } from '@tiptap/core';

const editors: Editor[] = [];
afterEach(() => {
	for (const e of editors) e.destroy();
	editors.length = 0;
});

/** Mirrors the real TomboyEditor extension set (heading enabled, size mark present). */
function makeEditor(): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false,
				horizontalRule: false,
				blockquote: false,
				orderedList: false
			}),
			TomboyParagraph,
			TomboyListItem,
			TomboySize,
			FootnoteMarker,
			...TomboyInlineCheckbox,
			...TomboyInlineRadio,
			ClipboardFidelity
		],
		content: { type: 'doc', content: [{ type: 'paragraph' }] }
	});
	editors.push(editor);
	return editor;
}
const pasteEvent = () => new Event('paste') as ClipboardEvent;

function textOf(n: unknown): string | undefined {
	return (n as { text?: string } | undefined)?.text;
}
function firstOfType(json: JSONContent, type: string): JSONContent | undefined {
	return (json.content ?? []).find((b) => b.type === type);
}
function bulletTexts(json: JSONContent): string[] {
	const list = firstOfType(json, 'bulletList');
	return (list?.content ?? []).map((li) => textOf(li.content?.[0]?.content?.[0]) ?? '');
}
/** The size level of the first text run in the first paragraph, if any. */
function firstParaSize(json: JSONContent): { text?: string; level?: string } {
	const para = firstOfType(json, 'paragraph');
	const run = para?.content?.[0];
	const size = (run?.marks ?? []).find((m) => m.type === 'tomboySize');
	return { text: textOf(run), level: size?.attrs?.level as string | undefined };
}

describe('붙여넣기 인라인 슬라이스 불릿 인식 (실제 클립보드 single-line)', () => {
	it('인라인 HTML `<span>- 입력</span>` 도 불릿으로 변환되고 마커가 사라진다', () => {
		// 실제 앱/웹/슬랙에서 한 줄 복사 → 클립보드 text/html 이 블록(`<p>`)이 아니라
		// 인라인(span/text) 이라 PM 이 인라인 슬라이스로 파싱한다. 이 경로가 버그였다.
		const b = makeEditor();
		b.commands.selectAll();
		b.view.pasteHTML('<meta charset="utf-8"><span>- 입력</span>', pasteEvent());
		expect(bulletTexts(b.getJSON())).toEqual(['입력']);
	});

	it('인라인 슬라이스라도 마커가 없으면 평문 그대로(인라인 병합 보존)', () => {
		const b = makeEditor();
		b.commands.insertContent('앞');
		b.view.pasteHTML('<span>뒤</span>', pasteEvent());
		// bulletList 로 오변환되지 않고 문단 하나로 남는다.
		expect(firstOfType(b.getJSON(), 'bulletList')).toBeUndefined();
	});
});

describe('붙여넣기 마크다운 헤딩 인식 (→ tomboySize 마크, 라운드트립 안전)', () => {
	it('`### 제목` 텍스트가 large 사이즈 문단으로 변환된다 (마커 제거)', () => {
		const b = makeEditor();
		b.commands.selectAll();
		b.view.pasteText('### 제목', pasteEvent());
		expect(firstParaSize(b.getJSON())).toEqual({ text: '제목', level: 'large' });
	});

	it('`# 제목` 은 huge 사이즈', () => {
		const b = makeEditor();
		b.commands.selectAll();
		b.view.pasteText('# 큰제목', pasteEvent());
		expect(firstParaSize(b.getJSON())).toEqual({ text: '큰제목', level: 'huge' });
	});

	it('`## 제목` 은 large 사이즈', () => {
		const b = makeEditor();
		b.commands.selectAll();
		b.view.pasteText('## 중제목', pasteEvent());
		expect(firstParaSize(b.getJSON())).toEqual({ text: '중제목', level: 'large' });
	});

	it('헤딩 노드(`<h2>`)도 size 마크 문단으로 변환되어 heading 노드가 남지 않는다', () => {
		const b = makeEditor();
		b.commands.selectAll();
		b.view.pasteHTML('<h2>웹제목</h2>', pasteEvent());
		const types: string[] = [];
		b.state.doc.descendants((n) => {
			types.push(n.type.name);
		});
		expect(types).not.toContain('heading');
		expect(firstParaSize(b.getJSON())).toEqual({ text: '웹제목', level: 'large' });
	});

	it('`#` 뒤 공백이 없으면 헤딩이 아니다 (`#해시태그`)', () => {
		const b = makeEditor();
		b.commands.selectAll();
		b.view.pasteText('#해시태그', pasteEvent());
		expect(firstParaSize(b.getJSON())).toEqual({ text: '#해시태그', level: undefined });
	});

	it('헤딩과 불릿이 섞인 여러 줄 붙여넣기', () => {
		const b = makeEditor();
		b.commands.selectAll();
		b.view.pasteText('## 목록\n- 사과\n- 바나나', pasteEvent());
		const json = b.getJSON();
		expect(firstParaSize(json)).toEqual({ text: '목록', level: 'large' });
		expect(bulletTexts(json)).toEqual(['사과', '바나나']);
	});
});
