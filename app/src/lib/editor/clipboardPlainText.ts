/**
 * DOM-level copy / cut handlers that replace ProseMirror's default with a
 * Tomboy-shaped clipboard payload.
 *
 * Two flavors are written to the clipboard on every copy/cut:
 *
 *   - `text/plain` — the user-visible text, no markdown decoration. Block
 *     boundaries (paragraph↔paragraph, list-item↔list-item) become a single
 *     "\n" each. The default PM serializer uses "\n\n" between blocks, which
 *     surfaces as "extra blank lines" after pasting into a text editor.
 *
 *   - `text/html` — minimal semantic HTML from `tiptapToHtml` (<p>, <ul>,
 *     <li>, <strong>, etc; no inline styles or font attributes). Rich
 *     editors prefer this representation and will merge a copied list item
 *     into the destination list as a proper list item instead of inlining
 *     "- " text.
 *
 * 단, 이 커스텀 직렬화는 외부 앱용으로 lossy 하다 — 각주/체크박스/라디오
 * atom, 이미지, datetime·size 마크가 살아남지 못한다. 그래서 text/html 의
 * wrapper <div> 에 선택 Slice 의 JSON 원본을 `data-tomboy-slice` 속성으로
 * 같이 실어 보낸다. 노트→노트 붙여넣기는 clipboardFidelity.ts 의
 * clipboardParser 가 이 payload 를 Slice.fromJSON 으로 복원해 원본을
 * 그대로 재현하고, 외부 앱은 모르는 속성을 무시하고 안의 HTML 만 쓴다.
 */

import type { EditorView } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';
import { Slice } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import { tiptapToPlainText, tiptapToHtml } from './copyFormatted.js';

/**
 * 내부 노트↔노트 정확 복원 payload 속성 이름. 쓰는 쪽은 이 파일의
 * `buildClipboardHtml`, 읽는 쪽은 clipboardFidelity.ts 의 clipboardParser.
 */
export const TOMBOY_SLICE_ATTR = 'data-tomboy-slice';

/** Convert a PM selection slice to a doc JSON, with trailing empty-paragraph cleanup. */
function sliceToDoc(slice: Slice): JSONContent | null {
	const raw = slice.content.toJSON() as JSONContent[] | undefined;
	if (!raw || raw.length === 0) return null;
	const nodes = [...raw];
	// ProseMirror places an auto-inserted empty paragraph after a top-level
	// list so the cursor can live past the list's end — same drop logic as
	// noteContentArchiver.ts's serializeContent. Without this, copying a
	// list via selectAll leaves a dangling trailing newline / empty <p>.
	if (nodes.length >= 2) {
		const last = nodes[nodes.length - 1];
		const secondLast = nodes[nodes.length - 2];
		const isEmptyPara =
			last.type === 'paragraph' && (!last.content || last.content.length === 0);
		if (
			isEmptyPara &&
			(secondLast.type === 'bulletList' || secondLast.type === 'orderedList')
		) {
			nodes.pop();
		}
	}
	return { type: 'doc', content: nodes };
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * text/html flavor 빌더 — 외부 앱용 minimal semantic HTML 을 그대로 두고,
 * 내부 붙여넣기용 정확 복원 payload 를 wrapper <div> 속성 두 개로 끼운다.
 *
 *  - `data-tomboy-slice` — 선택 Slice 의 JSON 원본. 같은 스키마의 에디터가
 *    Slice.fromJSON 으로 복원하면 플러그인 atom(각주·체크박스·라디오·이미지)
 *    과 모든 마크, 빈 paragraph 까지 그대로 살아남는다.
 *  - `data-pm-slice="O E []"` — PM 자체 마커. parseFromClipboard 가 이 값을
 *    보고 openStart/openEnd 재계산(maxOpen) 을 건너뛰고, TipTap paste rule
 *    들도 PM 내부 출처로 인식해 재변환을 생략한다. 형식은 PM 의
 *    `/^(\d+) (\d+)(?: -(\d+))? (.*)/` 정규식에 맞춰야 하므로 빈 컨텍스트
 *    `[]` 가 꼭 붙는다.
 */
export function buildClipboardHtml(slice: Slice, doc: JSONContent): string {
	const sliceJson = JSON.stringify(slice.toJSON() ?? {});
	return (
		`<div data-pm-slice="${slice.openStart} ${slice.openEnd} []" ` +
		`${TOMBOY_SLICE_ATTR}="${escapeAttr(sliceJson)}">${tiptapToHtml(doc)}</div>`
	);
}

/**
 * 컨텍스트 메뉴 복사용 — 선택이 비어 있으면 (기존 동작대로) 문서 전체를
 * 닫힌 슬라이스로 돌려준다.
 */
export function copySelectionSlice(state: EditorState): Slice {
	const sel = state.selection;
	if (!sel.empty) return sel.content();
	return new Slice(state.doc.content, 0, 0);
}

function writeClipboard(clipboardData: DataTransfer, doc: JSONContent, slice: Slice): void {
	clipboardData.setData('text/plain', tiptapToPlainText(doc));
	clipboardData.setData('text/html', buildClipboardHtml(slice, doc));
}

export function handleClipboardCopy(view: EditorView, event: ClipboardEvent): boolean {
	const sel = view.state.selection;
	if (sel.empty) return false;
	const clipboardData = event.clipboardData;
	if (!clipboardData) return false;
	const slice = sel.content();
	const doc = sliceToDoc(slice);
	if (!doc) return false;
	event.preventDefault();
	writeClipboard(clipboardData, doc, slice);
	return true;
}

export function handleClipboardCut(view: EditorView, event: ClipboardEvent): boolean {
	const sel = view.state.selection;
	if (sel.empty) return false;
	const clipboardData = event.clipboardData;
	if (!clipboardData) return false;
	const slice = sel.content();
	const doc = sliceToDoc(slice);
	if (!doc) return false;
	event.preventDefault();
	writeClipboard(clipboardData, doc, slice);
	view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
	return true;
}
