/**
 * 각주 마커 atomic 노드.
 *
 * `[^N]` 텍스트가 NOT 아니라 단일 ProseMirror 노드. 캐럿이 안으로 진입할
 * 수 없고(atom) 부분 삭제도 불가. 라운드트립은 archiver
 * (noteContentArchiver.ts) 에서 [^N] 텍스트 ↔ 노드로 변환.
 *
 * NodeView 의 ref/def 분기는 위치 의존적이라 노드 JSON 만 보면 알 수
 * 없다. PM 의 `matchesNode` 는 노드 + 데코레이션이 동일하면 `update` 를
 * 아예 호출하지 않으므로, 같은 파일 안에 작은 데코레이션 플러그인을
 * 둬서 def 위치의 마커에 `data-fn-kind=def` 를 달아준다. 데코레이션이
 * 바뀌면 PM 이 `update` 를 호출 → NodeView 가 def/ref 전환을 감지하고
 * `return false` 로 재생성을 유도한다.
 */
import { InputRule, Node } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { Fragment, Slice, type Node as PMNode, type NodeType, type ResolvedPos } from '@tiptap/pm/model';

/**
 * 정의 마커 판정 — top-level paragraph (제목 idx=0 제외) 의 첫 비공백 inline 자식.
 * 리스트 등 깊은 컨테이너 안의 마커는 항상 ref.
 *
 * NodeView (`isDefinitionPosition`), 데코레이션 (`isDefinitionAt`), 그리고
 * `footnotes.ts` 의 매치 수집 — 세 호출지가 같은 규칙을 쓰도록 ResolvedPos
 * 단일 입력으로 통일한다.
 */
export function isDefinitionResolved($pos: ResolvedPos): boolean {
	if ($pos.depth !== 1) return false;
	if ($pos.parent.type.name !== 'paragraph') return false;
	if ($pos.index(0) === 0) return false;
	const myIndex = $pos.index();
	let sawContent = false;
	$pos.parent.forEach((child, _offset, idx) => {
		if (idx >= myIndex || sawContent) return;
		if (child.isText) {
			if (/\S/.test(child.text ?? '')) sawContent = true;
		} else {
			sawContent = true;
		}
	});
	return !sawContent;
}

function isDefinitionPosition(
	getPos: () => number | undefined,
	view: EditorView
): boolean {
	const pos = getPos();
	if (pos == null) return false;
	return isDefinitionResolved(view.state.doc.resolve(pos));
}

function isDefinitionAt(doc: PMNode, pos: number): boolean {
	return isDefinitionResolved(doc.resolve(pos));
}

const footnoteKindPluginKey = new PluginKey('footnoteKindDecorations');

function buildKindDecorations(doc: PMNode): DecorationSet {
	const decos: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== 'footnoteMarker') return;
		const def = isDefinitionAt(doc, pos);
		decos.push(
			Decoration.node(pos, pos + node.nodeSize, {
				'data-fn-kind': def ? 'def' : 'ref'
			})
		);
	});
	return DecorationSet.create(doc, decos);
}

export const FootnoteMarker = Node.create({
	name: 'footnoteMarker',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,

	addAttributes() {
		return {
			label: { default: '' }
		};
	},

	parseHTML() {
		return [
			{
				tag: 'span.tomboy-fn-marker',
				getAttrs: (el) => ({
					label: (el as HTMLElement).getAttribute('data-label') ?? ''
				})
			}
		];
	},

	renderHTML({ node }) {
		return [
			'span',
			{ class: 'tomboy-fn-marker', 'data-label': node.attrs.label },
			node.attrs.label
		];
	},

	addInputRules() {
		const type = this.type;
		return [
			new InputRule({
				find: /\[\^([^\]\s]+)\]$/,
				handler: ({ state, range, match }) => {
					const $from = state.doc.resolve(range.from);
					// 제목 (top-level idx 0) 에서는 차단.
					if ($from.index(0) === 0) return null;
					const node = type.create({ label: match[1] });
					state.tr.replaceWith(range.from, range.to, node);
				}
			})
		];
	},

	addProseMirrorPlugins() {
		const type = this.type;
		return [
			new Plugin({
				key: footnoteKindPluginKey,
				state: {
					init: (_config, state) => buildKindDecorations(state.doc),
					apply: (tr, old) => (tr.docChanged ? buildKindDecorations(tr.doc) : old)
				},
				props: {
					decorations(state) {
						return this.getState(state);
					}
				}
			}),
			createPasteTransformPlugin(type)
		];
	},

	addNodeView() {
		return ({ node, getPos, editor }) => {
			const view = editor.view;
			const getPosFn = getPos as () => number | undefined;
			let isDef = isDefinitionPosition(getPosFn, view);
			const dom = document.createElement(isDef ? 'span' : 'sup');
			dom.className = isDef ? 'tomboy-fn-def' : 'tomboy-fn-ref';
			dom.textContent = node.attrs.label;
			return {
				dom,
				update(updatedNode) {
					if (updatedNode.type.name !== 'footnoteMarker') return false;
					const newIsDef = isDefinitionPosition(getPosFn, view);
					if (newIsDef !== isDef) {
						// 태그가 바뀌어야 하므로 PM 이 NodeView 재생성하도록.
						return false;
					}
					if (updatedNode.attrs.label !== dom.textContent) {
						dom.textContent = updatedNode.attrs.label;
					}
					isDef = newIsDef;
					return true;
				}
			};
		};
	}
});

const FN_PASTE_RE = /\[\^([^\]\s]+)\]/g;

/**
 * Paste fragment 안의 text 노드를 [^N] 패턴으로 split → footnoteMarker 노드 삽입.
 * 마크는 좌우 텍스트에만 전달 (atomic 노드는 마크 못 받음).
 */
function transformPastedSlice(slice: Slice, fnType: NodeType): Slice {
	const newContent = transformFragment(slice.content, fnType);
	if (newContent === slice.content) return slice;
	return new Slice(newContent, slice.openStart, slice.openEnd);
}

function transformFragment(frag: Fragment, fnType: NodeType): Fragment {
	const out: PMNode[] = [];
	let changed = false;
	frag.forEach((child) => {
		if (child.isText && typeof child.text === 'string') {
			FN_PASTE_RE.lastIndex = 0;
			const text = child.text;
			let last = 0;
			let m: RegExpExecArray | null;
			let split = false;
			const pieces: PMNode[] = [];
			while ((m = FN_PASTE_RE.exec(text)) !== null) {
				split = true;
				if (m.index > last) {
					pieces.push(child.cut(last, m.index));
				}
				pieces.push(fnType.create({ label: m[1] }));
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
			const inner = transformFragment(child.content, fnType);
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

function createPasteTransformPlugin(fnType: NodeType): Plugin {
	return new Plugin({
		props: {
			transformPasted: (slice) => transformPastedSlice(slice, fnType)
		}
	});
}
