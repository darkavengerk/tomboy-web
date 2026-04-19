/**
 * Slip-note arrow decorations.
 *
 * When `storage.enabled` is true and the doc's block[2] / block[3] are the
 * standard `이전:` / `다음:` paragraphs, this plugin:
 *   • Merges both arrows onto block 2's line (prev on the far left, next on
 *     the far right) and hides the original text there.
 *   • Collapses block 3 via `display: none` so the arrow pair occupies a
 *     single line.
 *
 * The original paragraph content stays in the document for round-trip XML;
 * only rendering is masked. Clicking an arrow calls
 * `storage.onNavigate(target)` with the internal link target. Disabled
 * when the corresponding field has no link (HEAD / TAIL).
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface SlipNoteArrowsStorage {
	enabled: boolean;
	onNavigate: (target: string) => void;
}

const pluginKey = new PluginKey('slipNoteArrows');

export const SlipNoteArrows = Extension.create<
	Record<string, never>,
	SlipNoteArrowsStorage
>({
	name: 'slipNoteArrows',

	addStorage() {
		return {
			enabled: false,
			onNavigate: () => {}
		};
	},

	addProseMirrorPlugins() {
		const storage = this.storage;
		return [
			new Plugin({
				key: pluginKey,
				props: {
					decorations: (state) => {
						if (!storage.enabled) return DecorationSet.empty;
						return buildDecorations(state.doc, () => storage.onNavigate);
					}
				}
			})
		];
	}
});

function buildDecorations(
	doc: PMNode,
	getHandler: () => (target: string) => void
): DecorationSet {
	const blocks: { block: PMNode; offset: number }[] = [];
	doc.forEach((block, offset) => {
		blocks.push({ block, offset });
	});

	if (blocks.length < 4) return DecorationSet.empty;

	const prev = parseLabeledLine(blocks[2].block, '이전');
	const next = parseLabeledLine(blocks[3].block, '다음');

	// Both lines must be well-formed for the merged bar to make sense.
	// Otherwise leave the paragraphs untouched so the user can see what's
	// wrong.
	if (!prev || !next) return DecorationSet.empty;

	const decorations: Decoration[] = [];
	const carrier = blocks[2];
	const hidden = blocks[3];

	decorations.push(
		Decoration.node(
			carrier.offset,
			carrier.offset + carrier.block.nodeSize,
			{ class: 'slipnote-line slipnote-combined-line' }
		)
	);

	decorations.push(
		Decoration.widget(
			carrier.offset + 1,
			makeArrowFactory('prev', '이전', prev.target, getHandler),
			{
				side: -1,
				ignoreSelection: true,
				key: `slip-prev-${prev.target ?? 'none'}`
			}
		)
	);

	decorations.push(
		Decoration.widget(
			carrier.offset + carrier.block.nodeSize - 1,
			makeArrowFactory('next', '다음', next.target, getHandler),
			{
				side: 1,
				ignoreSelection: true,
				key: `slip-next-${next.target ?? 'none'}`
			}
		)
	);

	decorations.push(
		Decoration.node(
			hidden.offset,
			hidden.offset + hidden.block.nodeSize,
			{ class: 'slipnote-hidden-line' }
		)
	);

	return DecorationSet.create(doc, decorations);
}

function parseLabeledLine(
	block: PMNode,
	label: '이전' | '다음'
): { target: string | null } | null {
	if (block.type.name !== 'paragraph') return null;
	const prefix = new RegExp(`^\\s*${label}\\s*:\\s*`);
	if (!prefix.test(block.textContent)) return null;

	let target: string | null = null;
	block.descendants((node) => {
		if (target) return false;
		if (node.isText) {
			const mark = node.marks.find((m) => m.type.name === 'tomboyInternalLink');
			if (mark) {
				const t = mark.attrs.target;
				if (typeof t === 'string' && t.trim()) target = t.trim();
			}
		}
		return true;
	});
	return { target };
}

function makeArrowFactory(
	direction: 'prev' | 'next',
	label: string,
	target: string | null,
	getHandler: () => (target: string) => void
): () => HTMLElement {
	return () => {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = `slipnote-arrow slipnote-arrow-${direction}`;
		btn.contentEditable = 'false';
		btn.setAttribute('aria-label', `${label} 슬립노트`);
		if (target) btn.title = target;
		btn.disabled = !target;
		btn.innerHTML =
			direction === 'prev'
				? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>'
				: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
		btn.addEventListener('mousedown', (e) => {
			e.preventDefault();
		});
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!target) return;
			getHandler()(target);
		});
		return btn;
	};
}
