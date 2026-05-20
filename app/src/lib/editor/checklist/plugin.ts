/**
 * ProseMirror 플러그인: 체크리스트 영역의 각 listItem 에 체크박스 위젯과
 * 불릿 숨김 노드 클래스를 데코레이션으로 단다. 체크 상태는 listItem 의
 * `checked` 속성에서 읽으며, 이 플러그인은 문서를 변형하지 않는다.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

import { findChecklistRegions, findChecklistItems } from './regions.js';

export interface ChecklistPluginOptions {
	/** 체크박스 클릭 시 호출. liPos 는 listItem 노드 위치. */
	onToggle: (liPos: number) => void;
}

export const checklistPluginKey = new PluginKey<DecorationSet>(
	'tomboyChecklist'
);

function buildCheckbox(
	view: EditorView,
	getPos: () => number | undefined,
	checked: boolean,
	onToggle: ChecklistPluginOptions['onToggle']
): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = checked
		? 'tomboy-checkbox-box is-checked'
		: 'tomboy-checkbox-box';
	btn.setAttribute('contenteditable', 'false');
	btn.setAttribute('data-no-drag', '');
	btn.setAttribute('aria-label', checked ? '체크 해제' : '체크');
	btn.addEventListener('mousedown', (e) => {
		// PM 이 포커스/선택을 위젯으로 가져가지 못하게.
		e.preventDefault();
		e.stopPropagation();
	});
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const p = getPos();
		if (p == null) return;
		// 위젯은 contentStart(liPos+2)에 놓임 → listItem 은 2 앞.
		const liPos = p - 2;
		const node = view.state.doc.nodeAt(liPos);
		if (!node || node.type.name !== 'listItem') return;
		onToggle(liPos);
	});
	return btn;
}

function buildDecorations(
	doc: PMNode,
	onToggle: ChecklistPluginOptions['onToggle']
): DecorationSet {
	const decos: Decoration[] = [];
	const regions = findChecklistRegions(doc);
	const items = findChecklistItems(regions);
	for (const it of items) {
		const liEnd = it.liPos + it.liNode.nodeSize;
		decos.push(
			Decoration.node(it.liPos, liEnd, {
				class: it.checked
					? 'tomboy-checkbox-item is-checked'
					: 'tomboy-checkbox-item'
			})
		);
		decos.push(
			Decoration.widget(
				it.contentStart,
				(view, getPos) =>
					buildCheckbox(view, getPos, it.checked, onToggle),
				{
					side: -1,
					ignoreSelection: true,
					// liPos 로 항목마다 고유 + checked 로 토글 시 변경 → PM 이
					// 잘못된 위젯 DOM 을 재사용하지 않고, 토글 시 다시 렌더한다.
					key: `tomboy-checkbox-${it.liPos}-${it.checked ? 'on' : 'off'}`
				}
			)
		);
	}
	return DecorationSet.create(doc, decos);
}

export function createChecklistPlugin(
	options: ChecklistPluginOptions
): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: checklistPluginKey,
		state: {
			init(_, state) {
				return buildDecorations(state.doc, options.onToggle);
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				return buildDecorations(newState.doc, options.onToggle);
			}
		},
		props: {
			decorations(state) {
				return checklistPluginKey.getState(state) ?? null;
			}
		}
	});
}
