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
import {
	createListBoxPlugin,
	listBoxPluginKey,
	type ListBoxPluginOptions
} from './plugin.js';
import { getExcludedListRanges, posInExcludedList } from './regions.js';

export { getExcludedListRanges, posInExcludedList } from './regions.js';
export { toggleRadioAt } from './commands.js';
export { listBoxPluginKey };
export type { ListBoxPluginOptions };

export const TomboyListBox = Extension.create<ListBoxPluginOptions>({
	name: 'tomboyListBox',

	addOptions() {
		return {
			onToggleCheck: () => {},
			onToggleRadio: () => {}
		};
	},

	addInputRules() {
		return createListBoxInputRules();
	},

	addKeyboardShortcuts() {
		return {
			// 내용 맨 앞 Backspace → 박스 제거(일반 불릿 복원).
			// 마지막 한 글자 Backspace → PM 트랜잭션으로 직접 삭제.
			// 그 외엔 false 반환으로 기존 리스트 Backspace 체인에 폴스루.
			Backspace: () => {
				const { state } = this.editor;
				const { $from, empty } = state.selection;
				if (!empty) return false;
				if ($from.parent.type.name !== 'paragraph' || $from.depth < 2)
					return false;
				const li = $from.node(-1);
				if (li.type.name !== 'listItem') return false;
				if ($from.index(-1) !== 0) return false; // li 의 첫 문단만
				const liPos = $from.before(-1);

				if ($from.parentOffset === 0) {
					if (!li.attrs.boxKind) return false;
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

				// 마지막 한 글자 삭제는 브라우저 네이티브 삭제에 맡기지 않고
				// PM 이 직접 지운다. 위젯이 문단 머리에 붙은 li 는 글자를
				// 지우면 <p> 에 위젯만 남는데, 그 DOM 변이를 prosemirror-view
				// readDOMChange 가 블록 분할로 보고 시뮬레이션 Enter 를
				// 디스패치한다 — 글자는 안 지워지고 줄이 갈라지는 버그.
				// checklist/process 영역 li 도 같은 위젯 구조라 함께 막는다.
				const para = $from.parent;
				if ($from.parentOffset !== para.content.size) return false;
				const only = para.childCount === 1 ? para.firstChild : null;
				if (!only) return false;
				const isLastUnit = only.isText
					? [...(only.text ?? '')].length === 1 // 단일 코드포인트
					: true; // 단일 인라인 atom
				if (!isLastUnit) return false;
				const hasWidget =
					!!li.attrs.boxKind ||
					posInExcludedList(getExcludedListRanges(state.doc), liPos);
				if (!hasWidget) return false;
				return this.editor.commands.command(({ tr, dispatch }) => {
					if (dispatch) tr.delete(liPos + 2, liPos + 2 + para.content.size);
					return true;
				});
			}
		};
	},

	addProseMirrorPlugins() {
		return [createListBoxPlugin(this.options)];
	}
});
