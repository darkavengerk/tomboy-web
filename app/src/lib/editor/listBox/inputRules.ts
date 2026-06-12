/**
 * 리스트 항목 첫 문단 시작에서 [[ ]]/[[x]] → boxKind='checkbox',
 * (( ))/((o)) → boxKind='radio'. 마커 텍스트는 삭제되고 불릿이
 * 체크박스/라디오로 교체된다 (렌더는 plugin.ts 데코레이션).
 * 인라인 atom 규칙과의 충돌은 inlineCheckbox/inlineRadio 쪽
 * lookbehind 가 막는다.
 */
import { InputRule } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

import { getExcludedListRanges, posInExcludedList } from './regions.js';

type BoxKind = 'checkbox' | 'radio';

/**
 * 마커 입력 위치가 "li 첫 문단의 블록 시작"이면 그 listItem 위치를,
 * 아니면 null 을 반환. 체크리스트: 영역/프로세스 리스트는 제외.
 */
function liPosForMarker(state: EditorState, from: number): number | null {
	const $from = state.doc.resolve(from);
	if ($from.parentOffset !== 0) return null;
	if ($from.parent.type.name !== 'paragraph') return null;
	if ($from.depth < 2) return null;
	const li = $from.node(-1);
	if (li.type.name !== 'listItem') return null;
	if ($from.index(-1) !== 0) return null; // li 의 첫 문단만
	const liPos = $from.before(-1);
	if (posInExcludedList(getExcludedListRanges(state.doc), liPos)) return null;
	return liPos;
}

function makeRule(find: RegExp, kind: BoxKind): InputRule {
	return new InputRule({
		find,
		handler: ({ state, range, match }) => {
			const liPos = liPosForMarker(state, range.from);
			if (liPos == null) return null;
			const li = state.doc.nodeAt(liPos);
			if (!li) return null;
			const checked = /[xXoO]/.test(match[1]);
			state.tr
				.delete(range.from, range.to)
				.setNodeMarkup(liPos, undefined, {
					...li.attrs,
					boxKind: kind,
					checked
				});
		}
	});
}

export function createListBoxInputRules(): InputRule[] {
	return [
		makeRule(/^\[\[([ xX])\]\]$/, 'checkbox'),
		makeRule(/^\(\(([ oO])\)\)$/, 'radio')
	];
}
