/**
 * 항목 단위 체크박스/라디오 (listBox).
 *
 * 리스트 항목 첫머리에서 [[ ]]/(( )) 입력 → 불릿이 통째 체크박스/
 * 라디오로 교체된다. 체크리스트: 영역(헤더 단위)과 독립 공존.
 * 상태는 listItem attrs(boxKind/checked), 렌더는 데코레이션,
 * XML 라운드트립은 noteContentArchiver 의 per-item 마커.
 */
import { Extension } from '@tiptap/core';

import { createListBoxInputRules } from './inputRules.js';

export { getExcludedListRanges, posInExcludedList } from './regions.js';

export const TomboyListBox = Extension.create({
	name: 'tomboyListBox',

	addInputRules() {
		return createListBoxInputRules();
	},

	addKeyboardShortcuts() {
		return {
			// 내용 맨 앞 Backspace → 박스 제거(일반 불릿 복원). 그 외엔
			// false 반환으로 기존 리스트 Backspace 체인에 폴스루.
			Backspace: () => {
				const { state } = this.editor;
				const { $from, empty } = state.selection;
				if (!empty || $from.parentOffset !== 0) return false;
				if ($from.parent.type.name !== 'paragraph' || $from.depth < 2)
					return false;
				const li = $from.node(-1);
				if (li.type.name !== 'listItem' || !li.attrs.boxKind) return false;
				if ($from.index(-1) !== 0) return false;
				const liPos = $from.before(-1);
				return this.editor.commands.command(({ tr, dispatch }) => {
					if (dispatch) {
						tr.setNodeMarkup(liPos, undefined, {
							...li.attrs,
							boxKind: null,
							checked: false
						});
					}
					return true;
				});
			}
		};
	}
});
