/**
 * 체크리스트 명령: 항목 체크 토글, Ctrl+P 체크리스트 블록 삽입.
 */
import type { Editor } from '@tiptap/core';
import { TextSelection } from 'prosemirror-state';

import { SKIP_TRAILING_NODE } from '../listItemDepth.js';

/**
 * `liPos` 의 listItem 의 `checked` 속성을 반전한다. 해당 위치가 listItem
 * 이 아니면 false 를 반환하고 아무것도 하지 않는다.
 */
export function toggleCheckboxAt(editor: Editor, liPos: number): boolean {
	const { state } = editor;
	const node = state.doc.nodeAt(liPos);
	if (!node || node.type.name !== 'listItem') return false;
	const tr = state.tr.setNodeMarkup(liPos, undefined, {
		...node.attrs,
		checked: !node.attrs.checked
	});
	editor.view.dispatch(tr);
	return true;
}

/**
 * Ctrl/Cmd+P 핸들러. 커서의 최상위 블록 다음에 `체크리스트:` 문단 +
 * 빈 항목 하나짜리 bulletList 를 삽입하고 커서를 그 항목 안으로 옮긴다.
 * 커서 블록이 빈 비제목 문단이면 그 문단을 대체한다.
 */
export function insertChecklistBlock(editor: Editor): void {
	const { state } = editor;
	const schema = state.schema;
	const { $from } = state.selection;
	if ($from.depth < 1) return;

	const topIdx = $from.index(0);
	const topNode = state.doc.child(topIdx);
	const topStart = $from.before(1);
	const topEnd = $from.after(1);

	const headerPara = schema.nodes.paragraph.create(
		null,
		schema.text('체크리스트:')
	);
	const emptyLi = schema.nodes.listItem.create(
		null,
		schema.nodes.paragraph.create()
	);
	const newList = schema.nodes.bulletList.create(null, emptyLi);

	const tr = state.tr;
	const currentIsEmptyPara =
		topNode.type.name === 'paragraph' &&
		topNode.content.size === 0 &&
		topIdx > 0;

	let insertedAt: number;
	if (currentIsEmptyPara) {
		tr.replaceWith(topStart, topEnd, [headerPara, newList]);
		insertedAt = topStart;
	} else {
		tr.insert(topEnd, [headerPara, newList]);
		insertedAt = topEnd;
	}

	// 커서를 빈 항목의 문단 안에 둔다:
	//   insertedAt              -> headerPara 앞
	//   + headerPara.nodeSize   -> newList 앞 (bulletList 여는 토큰)
	//   + 1                     -> bulletList 안, listItem 앞
	//   + 1                     -> listItem 안, paragraph 앞
	//   + 1                     -> paragraph 안 (커서)
	const caret = insertedAt + headerPara.nodeSize + 3;
	const clamped = Math.max(1, Math.min(caret, tr.doc.content.size - 1));
	try {
		tr.setSelection(TextSelection.near(tr.doc.resolve(clamped)));
	} catch {
		// 실패 시 선택 그대로 둔다.
	}
	tr.setMeta(SKIP_TRAILING_NODE, true);
	editor.view.dispatch(tr);
	editor.view.focus();
}
