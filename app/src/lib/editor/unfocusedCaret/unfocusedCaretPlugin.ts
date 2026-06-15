// Mobile contenteditable 은 키보드를 dismiss 하면 자동으로 blur 되고
// browser 의 native caret / selection 이 모두 사라진다. 사용자가 "어디를
// 편집/선택 중이었는지" 시각적으로 잃어버리는 게 불편해서, blur 상태
// 에서 ProseMirror state.selection 을 그대로 그려준다:
//   - collapsed (caret): selection.head 위치에 빈 widget span (blink)
//   - range: from..to 범위에 inline decoration (native selection 색 모방)
// focus 가 돌아오면 즉시 떼어내 native 처리에 양보.
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
				if (selection.empty) {
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
				}
				const range = Decoration.inline(
					selection.from,
					selection.to,
					{ class: 'unfocused-selection' },
					{ inclusiveStart: false, inclusiveEnd: false }
				);
				return DecorationSet.create(state.doc, [range]);
			},
			handleDOMEvents: {
				focus(view) {
					// Tearing the decoration down *synchronously* here makes
					// ProseMirror rewrite the pre-blur state.selection onto the
					// DOM during the redraw, clobbering the caret the click is
					// placing — the click's selection isn't synced into state
					// until the selectionchange / mouseup that *follows* this
					// focus event. So defer one macrotask (the caret has landed
					// by then) and flush() to pull the click selection into
					// state BEFORE the redraw dispatch, so state == DOM and the
					// redraw can't fight it. Desktop symptom this fixes:
					// clicking an unfocused note window snapped the cursor back
					// to its previous spot, ignoring where you clicked.
					setTimeout(() => {
						if (view.isDestroyed || !view.hasFocus()) return;
						// domObserver is internal to prosemirror-view but its
						// flush() has been stable for years; it syncs any pending
						// DOM selection change into state.
						(
							view as unknown as { domObserver: { flush(): void } }
						).domObserver.flush();
						const s = key.getState(view.state);
						if (s && !s.focused) {
							view.dispatch(view.state.tr.setMeta(key, { focused: true }));
						}
					}, 0);
					return false;
				},
				blur(view) {
					if (view.isDestroyed) return false;
					view.dispatch(view.state.tr.setMeta(key, { focused: false }));
					return false;
				}
			}
		}
	});
}
