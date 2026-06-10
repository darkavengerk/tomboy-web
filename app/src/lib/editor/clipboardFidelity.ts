/**
 * 클립보드 충실도 확장 — 붙여넣기 쪽 절반 (복사 쪽 짝: clipboardPlainText.ts).
 *
 * 두 가지를 고친다:
 *
 * 1. **노트→노트 Ctrl+V 원본 보존.** 복사 시 text/html 에 끼워 넣은
 *    `data-tomboy-slice` JSON payload 를 clipboardParser 가 감지해
 *    Slice.fromJSON 으로 정확 복원한다. 커스텀 직렬화(tiptapToHtml)가
 *    떨어뜨리던 각주/체크박스/라디오 atom, 이미지, datetime·size 마크,
 *    빈 paragraph 가 전부 그대로 살아남는다. payload 가 없거나(외부 출처)
 *    깨진 경우(다른 배포 버전 탭의 스키마 드리프트 등)는 조용히 PM 기본
 *    HTML 파싱으로 폴백.
 *
 * 2. **plain 붙여넣기(Ctrl+Shift+V·외부 텍스트)의 빈 줄 보존.** PM 기본
 *    텍스트 파서는 `text.split(/(?:\r\n?|\n)+/)` 로 연속 개행을 collapse
 *    해 빈 줄(= Tomboy 라인 모델의 빈 paragraph)을 날린다. clipboardTextParser
 *    로 한 줄 = paragraph, 빈 줄 = 빈 paragraph 로 대체한다.
 *
 * 마커 텍스트([^N], [x], ( ) 등)의 atom 재조립은 각 노드의 transformPasted
 * 가 parseFromClipboard 마지막 단계에서 이 뒤에 그대로 수행한다.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import {
	DOMParser as PMDOMParser,
	Fragment,
	Slice,
	type ParseOptions,
	type ResolvedPos,
	type Schema
} from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { TOMBOY_SLICE_ATTR } from './clipboardPlainText.js';

class TomboySliceClipboardParser extends PMDOMParser {
	parseSlice(dom: Node, options?: ParseOptions): Slice {
		const el = (dom as Element).querySelector?.(`[${TOMBOY_SLICE_ATTR}]`);
		const raw = el?.getAttribute(TOMBOY_SLICE_ATTR);
		if (raw) {
			try {
				return Slice.fromJSON(this.schema, JSON.parse(raw));
			} catch {
				// 손상 / 스키마 불일치 — 아래 HTML 파싱 폴백.
			}
		}
		return super.parseSlice(dom, options);
	}
}

/** PM 기본 파서의 rules 를 그대로 물려받는 payload-인식 클립보드 파서. */
export function buildClipboardParser(schema: Schema): PMDOMParser {
	return new TomboySliceClipboardParser(schema, PMDOMParser.fromSchema(schema).rules);
}

/**
 * 빈 줄 보존 plain text 파서. openStart/openEnd 는 PM 이 maxOpen 으로
 * 재정규화하므로 형식적인 값 — 의미는 paragraph 배열 자체에 있다.
 */
export function parsePlainTextLines(
	text: string,
	$context: ResolvedPos,
	view: EditorView
): Slice {
	const schema = view.state.schema;
	const marks = $context.marks();
	const paragraphs = text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) =>
			schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : undefined)
		);
	return new Slice(Fragment.fromArray(paragraphs), 1, 1);
}

export const ClipboardFidelity = Extension.create({
	name: 'tomboyClipboardFidelity',

	addProseMirrorPlugins() {
		const parser = buildClipboardParser(this.editor.schema);
		return [
			new Plugin({
				key: new PluginKey('tomboyClipboardFidelity'),
				props: {
					clipboardParser: parser,
					clipboardTextParser: (text, $context, _plainText, view) =>
						parsePlainTextLines(text, $context, view)
				}
			})
		];
	}
});
