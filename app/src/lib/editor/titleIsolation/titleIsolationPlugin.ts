import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { isCursorInTitleBlock } from '$lib/editor/titleUniqueGuard.js';
import { suppressesSubtitle } from '$lib/editor/subtitleSlot.js';

export const titleIsolationPluginKey = new PluginKey('tomboyTitleIsolation');

/**
 * 첫 top-level 노드(=타이틀)를 화면에서 분리한다.
 *  1) `decorations` — 첫 노드에 `.tomboy-title-hidden`(display:none) 부여.
 *  2) `appendTransaction` — selection 이 첫 노드 안으로 들어가면 본문 시작으로
 *     클램프(↑/Ctrl+Home/클릭 진입 차단). 둘째 줄(서브타이틀 슬롯)이 비어 있으면
 *     날짜 플레이스홀더만 있는 빈 줄을 건너뛰고 셋째 줄(본문) 시작으로 보낸다 —
 *     노트를 열었을 때 기본 커서가 빈 서브타이틀 줄이 아닌 본문에 놓이도록.
 *  3) `handleKeyDown` — 둘째 블록 맨 앞 Backspace 가 타이틀로 병합되는 것을 차단.
 *
 * `enabled()` 클로저 게이트로 prop 토글이 에디터 재생성 없이 반영된다.
 * 데이터(문서)는 그대로 — 직렬화/추출/라운드트립 전부 무영향.
 */
export function createTitleIsolationPlugin(enabled: () => boolean): Plugin {
	return new Plugin({
		key: titleIsolationPluginKey,
		props: {
			decorations(state) {
				if (!enabled()) return null;
				const first = state.doc.firstChild;
				if (!first) return null;
				return DecorationSet.create(state.doc, [
					Decoration.node(0, first.nodeSize, { class: 'tomboy-title-hidden' })
				]);
			},
			handleKeyDown(view, event) {
				if (!enabled() || event.key !== 'Backspace') return false;
				const { selection, doc } = view.state;
				if (!selection.empty) return false;
				const first = doc.firstChild;
				if (!first || doc.childCount < 2) return false;
				// 둘째 블록 콘텐츠 시작 = first.nodeSize + 1.
				if (selection.from === first.nodeSize + 1) return true; // 병합 차단
				return false;
			}
		},
		appendTransaction(_transactions, _oldState, newState) {
			if (!enabled()) return null;
			const { doc, selection } = newState;
			if (doc.childCount < 2) return null; // 보호해 들어갈 둘째 블록 없음
			if (
				!isCursorInTitleBlock(doc, selection.anchor) &&
				!isCursorInTitleBlock(doc, selection.head)
			) {
				return null;
			}
			const first = doc.firstChild!;
			// 기본 클램프 위치 = 둘째 블록(서브타이틀 슬롯) 시작.
			let target = first.nodeSize + 1;
			// 둘째 줄이 비어 있으면(=날짜 플레이스홀더만 보이는 줄) 본문인 셋째 줄
			// 시작으로 건너뛴다. `::` 노트(자동화/데이터)는 둘째 줄이 실제 로그/본문
			// 슬롯이므로 건너뛰지 않는다.
			const second = doc.child(1);
			if (
				!suppressesSubtitle(doc) &&
				second.content.size === 0 &&
				doc.childCount >= 3
			) {
				target = first.nodeSize + second.nodeSize + 1;
			}
			target = Math.min(target, doc.content.size);
			return newState.tr.setSelection(TextSelection.create(doc, target));
		}
	});
}
