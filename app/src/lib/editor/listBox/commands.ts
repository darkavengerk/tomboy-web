/**
 * 항목 단위 라디오 토글. 체크박스 쪽은 checklist/commands.ts 의
 * toggleCheckboxAt 를 그대로 재사용한다 (같은 checked attr).
 */
import type { Editor } from '@tiptap/core';

/**
 * `liPos` 의 라디오 항목을 토글한다 — 같은 bulletList 직계 형제
 * 라디오와 상호배타. 선택된 항목 재토글은 해제(none-selected 허용,
 * 인라인 라디오와 동일 규칙). 라디오 항목이 아니면 false.
 */
export function toggleRadioAt(editor: Editor, liPos: number): boolean {
	const { state } = editor;
	const node = state.doc.nodeAt(liPos);
	if (
		!node ||
		node.type.name !== 'listItem' ||
		node.attrs.boxKind !== 'radio'
	) {
		return false;
	}
	const $li = state.doc.resolve(liPos);
	const parentList = $li.parent;
	const tr = state.tr;
	if (node.attrs.checked === true) {
		tr.setNodeMarkup(liPos, undefined, { ...node.attrs, checked: false });
	} else {
		let offset = $li.start();
		parentList.forEach((child) => {
			const childPos = offset;
			offset += child.nodeSize;
			if (child.type.name !== 'listItem' || child.attrs.boxKind !== 'radio')
				return;
			if (childPos === liPos) {
				tr.setNodeMarkup(childPos, undefined, {
					...child.attrs,
					checked: true
				});
			} else if (child.attrs.checked === true) {
				tr.setNodeMarkup(childPos, undefined, {
					...child.attrs,
					checked: false
				});
			}
		});
	}
	editor.view.dispatch(tr);
	return true;
}
