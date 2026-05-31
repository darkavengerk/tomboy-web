/**
 * Inline 라디오 atomic 노드.
 *
 * 본문 어디서나 ( ) / (o) 입력 → atomic 노드. 캐럿 진입 불가, 부분
 * 삭제 불가, mark 도 받지 않는다. 같은 텍스트 블록 ($pos.parent =
 * paragraph / list-item 본체) 안의 다른 inlineRadio 와 상호 배타로
 * 동작 — 선택 시 형제 라디오들은 모두 해제. 선택된 라디오 재클릭은
 * 해제 (none selected 상태 허용). 라운드트립은 archiver
 * (noteContentArchiver.ts) 에서 ( ) / (o) 텍스트 ↔ 노드로 변환.
 */
import { InputRule, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

export const InlineRadio = Node.create({
	name: 'inlineRadio',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,
	marks: '',

	addAttributes() {
		return {
			selected: { default: false }
		};
	},

	parseHTML() {
		return [
			{
				tag: 'span.tomboy-inline-radio',
				getAttrs: (el) => ({
					selected: (el as HTMLElement).getAttribute('data-selected') === 'true'
				})
			}
		];
	},

	renderHTML({ node }) {
		return [
			'span',
			{
				class: 'tomboy-inline-radio',
				'data-selected': node.attrs.selected ? 'true' : 'false'
			}
		];
	},

	addInputRules() {
		const type = this.type;
		return [
			new InputRule({
				find: /\(([ oO])\)$/,
				handler: ({ state, range, match }) => {
					const $from = state.doc.resolve(range.from);
					if ($from.index(0) === 0) return null; // 제목 차단
					const selected = match[1] === 'o' || match[1] === 'O';
					const node = type.create({ selected });
					state.tr.replaceWith(range.from, range.to, node);
				}
			})
		];
	},

	addProseMirrorPlugins() {
		const type = this.type;
		return [createPasteTransformPlugin(type)];
	},

	addNodeView() {
		return ({ node, getPos, editor }) => {
			const view = editor.view;
			const getPosFn = getPos as () => number | undefined;
			const dom = document.createElement('span');
			dom.className = 'tomboy-inline-radio';
			dom.setAttribute('data-selected', node.attrs.selected ? 'true' : 'false');
			dom.contentEditable = 'false';
			dom.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const pos = getPosFn();
				if (pos == null) return;
				const current = view.state.doc.nodeAt(pos);
				if (!current || current.type.name !== 'inlineRadio') return;

				const $pos = view.state.doc.resolve(pos);
				const parent = $pos.parent;
				const parentStart = $pos.start();
				const wasSelected = current.attrs.selected;
				const tr = view.state.tr;

				if (wasSelected) {
					tr.setNodeAttribute(pos, 'selected', false);
				} else {
					parent.forEach((child, offset) => {
						if (child.type.name !== 'inlineRadio') return;
						const childPos = parentStart + offset;
						if (childPos === pos) {
							tr.setNodeAttribute(childPos, 'selected', true);
						} else if (child.attrs.selected) {
							tr.setNodeAttribute(childPos, 'selected', false);
						}
					});
				}
				view.dispatch(tr);
			});
			return {
				dom,
				update(updatedNode) {
					if (updatedNode.type.name !== 'inlineRadio') return false;
					dom.setAttribute(
						'data-selected',
						updatedNode.attrs.selected ? 'true' : 'false'
					);
					return true;
				}
			};
		};
	}
});

const RADIO_PASTE_RE = /\(([ oO])\)/g;

function transformPastedSlice(slice: Slice, radioType: NodeType): Slice {
	const newContent = transformFragment(slice.content, radioType);
	if (newContent === slice.content) return slice;
	return new Slice(newContent, slice.openStart, slice.openEnd);
}

function transformFragment(frag: Fragment, radioType: NodeType): Fragment {
	const out: PMNode[] = [];
	let changed = false;
	frag.forEach((child) => {
		if (child.isText && typeof child.text === 'string') {
			RADIO_PASTE_RE.lastIndex = 0;
			const text = child.text;
			let last = 0;
			let m: RegExpExecArray | null;
			let split = false;
			const pieces: PMNode[] = [];
			while ((m = RADIO_PASTE_RE.exec(text)) !== null) {
				split = true;
				if (m.index > last) {
					pieces.push(child.cut(last, m.index));
				}
				const selected = m[1] === 'o' || m[1] === 'O';
				pieces.push(radioType.create({ selected }));
				last = m.index + m[0].length;
			}
			if (split) {
				if (last < text.length) pieces.push(child.cut(last));
				out.push(...pieces);
				changed = true;
			} else {
				out.push(child);
			}
		} else if (child.content.size > 0) {
			const inner = transformFragment(child.content, radioType);
			if (inner !== child.content) {
				out.push(child.copy(inner));
				changed = true;
			} else {
				out.push(child);
			}
		} else {
			out.push(child);
		}
	});
	if (!changed) return frag;
	return Fragment.fromArray(out);
}

function createPasteTransformPlugin(radioType: NodeType): Plugin {
	return new Plugin({
		props: {
			transformPasted: (slice: Slice, view: EditorView) => {
				const $from = view.state.selection.$from;
				if ($from.depth >= 1 && $from.index(0) === 0) return slice;
				return transformPastedSlice(slice, radioType);
			}
		}
	});
}
