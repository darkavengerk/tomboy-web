/**
 * Inline 체크박스 atomic 노드.
 *
 * 본문 어디서나 [ ] / [x] 입력 → atomic 노드. 캐럿 진입 불가, 부분 삭제
 * 불가. mark 도 받지 않는다. 라운드트립은 archiver
 * (noteContentArchiver.ts) 에서 [ ] / [x] 텍스트 ↔ 노드로 변환.
 */
import { Node } from '@tiptap/core';

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

	addNodeView() {
		return ({ node }) => {
			const dom = document.createElement('span');
			dom.className = 'tomboy-inline-checkbox';
			dom.setAttribute('data-checked', node.attrs.checked ? 'true' : 'false');
			dom.contentEditable = 'false';
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
