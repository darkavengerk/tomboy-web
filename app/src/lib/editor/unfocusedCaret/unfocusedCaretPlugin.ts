// Mobile contenteditable 은 키보드를 dismiss 하면 자동으로 blur 되고
// browser 의 native caret 도 사라진다. 사용자가 "이 노트의 어디를 마지막
// 으로 편집했는지" 시각적으로 잃어버리는 게 불편해서, blur 상태에서도
// ProseMirror 의 state.selection (collapsed = caret) 위치에 빈 widget
// decoration 을 그려서 가짜 caret 을 표시한다. focus 가 돌아오면 즉시
// widget 을 떼고 native caret 에 양보.
//
// state.selection 은 native DOM selection 과 독립적으로 유지되므로 iOS
// 가 native selection 을 clear 해도 plugin 입장에선 항상 정확한 위치를
// 안다. focus / blur 는 handleDOMEvents 로 받아 plugin state 에 보관.

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const key = new PluginKey<{ focused: boolean }>('unfocusedCaret');

export function unfocusedCaretPlugin(): Plugin {
	return new Plugin({
		key,
		state: {
			init: () => ({ focused: false }),
			apply(tr, prev) {
				const next = tr.getMeta(key) as { focused: boolean } | undefined;
				return next ?? prev;
			}
		},
		props: {
			decorations(state) {
				const s = key.getState(state);
				if (!s || s.focused) return null;
				const { selection } = state;
				// caret 만 표시; range selection 은 일반적으로 blur 시 사라져도
				// 사용자가 신경 쓰지 않으므로 skip.
				if (!selection.empty) return null;
				const widget = Decoration.widget(
					selection.head,
					() => {
						const el = document.createElement('span');
						el.className = 'unfocused-caret';
						el.setAttribute('aria-hidden', 'true');
						return el;
					},
					{ side: -1, key: 'unfocused-caret' }
				);
				return DecorationSet.create(state.doc, [widget]);
			},
			handleDOMEvents: {
				focus(view) {
					view.dispatch(view.state.tr.setMeta(key, { focused: true }));
					return false;
				},
				blur(view) {
					view.dispatch(view.state.tr.setMeta(key, { focused: false }));
					return false;
				}
			}
		}
	});
}
