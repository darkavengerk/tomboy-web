/**
 * 각주 마커 atomic 노드.
 *
 * `[^N]` 텍스트가 NOT 아니라 단일 ProseMirror 노드. 캐럿이 안으로 진입할
 * 수 없고(atom) 부분 삭제도 불가. 라운드트립은 archiver
 * (noteContentArchiver.ts) 에서 [^N] 텍스트 ↔ 노드로 변환.
 *
 * 이 파일은 Task 1 에서 스키마만, Task 4 에서 NodeView 의 ref/def 위치
 * 기반 분기, Task 7 에서 input rule + paste transform 을 차례로 채운다.
 */
import { Node } from '@tiptap/core';

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

	addNodeView() {
		return ({ node }) => {
			// Task 4 에서 위치 기반 ref/def 분기로 교체. 지금은 항상 ref.
			const dom = document.createElement('sup');
			dom.className = 'tomboy-fn-ref';
			dom.textContent = node.attrs.label;
			return {
				dom,
				update(updatedNode) {
					if (updatedNode.type.name !== 'footnoteMarker') return false;
					if (updatedNode.attrs.label !== dom.textContent) {
						dom.textContent = updatedNode.attrs.label;
					}
					return true;
				}
			};
		};
	}
});
