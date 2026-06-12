/**
 * ProseMirror 플러그인: boxKind 가 설정된 listItem 에 불릿 숨김 노드
 * 클래스와 체크박스/라디오 위젯을 데코레이션으로 단다. 체크리스트
 * 영역 플러그인(checklist/plugin.ts)과 같은 패턴 — 문서는 변형하지
 * 않고, 상태는 listItem attrs 에서 읽는다. 영역 리스트는 통째로
 * 건너뛴다 (이중 위젯 방지).
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { buildCheckbox } from '../checklist/plugin.js';
import { getExcludedListRanges, posInExcludedList } from './regions.js';

export interface ListBoxPluginOptions {
	/** 체크박스 위젯 클릭. liPos 는 listItem 노드 위치. */
	onToggleCheck: (liPos: number) => void;
	/** 라디오 위젯 클릭. liPos 는 listItem 노드 위치. */
	onToggleRadio: (liPos: number) => void;
}

export const listBoxPluginKey = new PluginKey<DecorationSet>('tomboyListBox');

/** 원형 라디오 위젯 — buildCheckbox 와 같은 contentStart(liPos+2) 전제. */
function buildRadio(
	view: EditorView,
	getPos: () => number | undefined,
	selected: boolean,
	onToggle: (liPos: number) => void
): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = selected
		? 'tomboy-radio-box is-selected'
		: 'tomboy-radio-box';
	btn.setAttribute('contenteditable', 'false');
	btn.setAttribute('data-no-drag', '');
	btn.setAttribute('aria-label', selected ? '선택 해제' : '선택');
	btn.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const p = getPos();
		if (p == null) return;
		const liPos = p - 2; // 위젯은 contentStart(liPos+2)에 놓임
		const node = view.state.doc.nodeAt(liPos);
		if (!node || node.type.name !== 'listItem') return;
		onToggle(liPos);
	});
	return btn;
}

function buildDecorations(
	doc: PMNode,
	options: ListBoxPluginOptions
): DecorationSet {
	const decos: Decoration[] = [];
	const excluded = getExcludedListRanges(doc);
	doc.descendants((node, pos) => {
		if (
			node.type.name === 'bulletList' &&
			posInExcludedList(excluded, pos)
		) {
			return false; // 영역 리스트 통째 skip (중첩 자식 포함)
		}
		if (node.type.name !== 'listItem') return true;
		const kind = node.attrs?.boxKind;
		if (kind !== 'checkbox' && kind !== 'radio') return true;
		const firstChild = node.firstChild;
		if (!firstChild || firstChild.type.name !== 'paragraph') return true;
		const liPos = pos;
		const liEnd = liPos + node.nodeSize;
		const contentStart = liPos + 2;
		const checked = node.attrs.checked === true;
		if (kind === 'checkbox') {
			decos.push(
				Decoration.node(liPos, liEnd, {
					class: checked
						? 'tomboy-checkbox-item is-checked'
						: 'tomboy-checkbox-item'
				})
			);
			decos.push(
				Decoration.widget(
					contentStart,
					(view, getPos) =>
						buildCheckbox(view, getPos, checked, options.onToggleCheck),
					{
						side: -1,
						ignoreSelection: true,
						key: `tomboy-listbox-cb-${liPos}-${checked ? 'on' : 'off'}`
					}
				)
			);
		} else {
			decos.push(
				Decoration.node(liPos, liEnd, {
					class: checked
						? 'tomboy-radio-item is-selected'
						: 'tomboy-radio-item'
				})
			);
			decos.push(
				Decoration.widget(
					contentStart,
					(view, getPos) =>
						buildRadio(view, getPos, checked, options.onToggleRadio),
					{
						side: -1,
						ignoreSelection: true,
						key: `tomboy-listbox-rd-${liPos}-${checked ? 'on' : 'off'}`
					}
				)
			);
		}
		return true;
	});
	return DecorationSet.create(doc, decos);
}

export function createListBoxPlugin(
	options: ListBoxPluginOptions
): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: listBoxPluginKey,
		state: {
			init(_, state) {
				return buildDecorations(state.doc, options);
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return buildDecorations(newState.doc, options);
			}
		},
		props: {
			decorations(state) {
				return listBoxPluginKey.getState(state) ?? null;
			}
		}
	});
}
