/**
 * Inline 체크박스 atomic 노드.
 *
 * 본문 어디서나 [ ] / [x] 입력 → atomic 노드. 캐럿 진입 불가, 부분 삭제
 * 불가. mark 도 받지 않는다. 라운드트립은 archiver
 * (noteContentArchiver.ts) 에서 [ ] / [x] 텍스트 ↔ 노드로 변환.
 */
import { InputRule, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

export const InlineCheckbox = Node.create({
	name: 'inlineCheckbox',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,
	marks: '',

	addAttributes() {
		return {
			checked: { default: false }
		};
	},

	parseHTML() {
		return [
			{
				tag: 'span.tomboy-inline-checkbox',
				getAttrs: (el) => ({
					checked: (el as HTMLElement).getAttribute('data-checked') === 'true'
				})
			}
		];
	},

	renderHTML({ node }) {
		return [
			'span',
			{
				class: 'tomboy-inline-checkbox',
				'data-checked': node.attrs.checked ? 'true' : 'false'
			}
		];
	},

	addInputRules() {
		const type = this.type;
		return [
			new InputRule({
				// `[[X]]` (체크리스트 영역 통째 마커) 안 `[X]` 는 잡지 않음 —
				// 좌측 `[` lookbehind 로 차단. archiver split 정규식과 정책 일치.
				find: /(?<!\[)\[([ xX])\]$/,
				handler: ({ state, range, match }) => {
					const $from = state.doc.resolve(range.from);
					// 제목 (top-level idx 0) 차단 — 각주와 동일.
					if ($from.index(0) === 0) return null;
					const checked = match[1] === 'x' || match[1] === 'X';
					const node = type.create({ checked });
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
			dom.className = 'tomboy-inline-checkbox';
			dom.setAttribute('data-checked', node.attrs.checked ? 'true' : 'false');
			dom.contentEditable = 'false';
			dom.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const pos = getPosFn();
				if (pos == null) return;
				const current = view.state.doc.nodeAt(pos);
				if (!current || current.type.name !== 'inlineCheckbox') return;
				const next = !current.attrs.checked;
				view.dispatch(view.state.tr.setNodeAttribute(pos, 'checked', next));
			});
			return {
				dom,
				update(updatedNode) {
					if (updatedNode.type.name !== 'inlineCheckbox') return false;
					dom.setAttribute(
						'data-checked',
						updatedNode.attrs.checked ? 'true' : 'false'
					);
					return true;
				}
			};
		};
	}
});

// `[[X]]` 안 `[X]` 는 변환하지 않음 — 체크리스트 영역 통째 마커 보존.
// archiver 의 INLINE_CHECKBOX_SPLIT_RE / InputRule find 와 동일 정책.
const CB_PASTE_RE = /(?<!\[)\[([ xX])\](?!\])/g;

function transformPastedSlice(slice: Slice, cbType: NodeType): Slice {
	const newContent = transformFragment(slice.content, cbType);
	if (newContent === slice.content) return slice;
	return new Slice(newContent, slice.openStart, slice.openEnd);
}

function transformFragment(frag: Fragment, cbType: NodeType): Fragment {
	const out: PMNode[] = [];
	let changed = false;
	frag.forEach((child) => {
		if (child.isText && typeof child.text === 'string') {
			CB_PASTE_RE.lastIndex = 0;
			const text = child.text;
			let last = 0;
			let m: RegExpExecArray | null;
			let split = false;
			const pieces: PMNode[] = [];
			while ((m = CB_PASTE_RE.exec(text)) !== null) {
				split = true;
				if (m.index > last) {
					pieces.push(child.cut(last, m.index));
				}
				const checked = m[1] === 'x' || m[1] === 'X';
				pieces.push(cbType.create({ checked }));
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
			const inner = transformFragment(child.content, cbType);
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

function createPasteTransformPlugin(cbType: NodeType): Plugin {
	return new Plugin({
		props: {
			transformPasted: (slice: Slice, view: EditorView) => {
				// destination 이 제목 (idx 0) 이면 변환 skip.
				const $from = view.state.selection.$from;
				if ($from.depth >= 1 && $from.index(0) === 0) return slice;
				return transformPastedSlice(slice, cbType);
			}
		}
	});
}
