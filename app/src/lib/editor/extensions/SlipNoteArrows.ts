/**
 * Slip-note arrow decorations.
 *
 * When `storage.enabled` is true and the doc's block[2] / block[3] are the
 * standard `이전:` / `다음:` paragraphs, this plugin:
 *   • Merges both arrows onto block 2's line (prev on the far left, next on
 *     the far right) and hides the original text there.
 *   • Inserts a cluster of chain-edit action buttons between the arrows:
 *     insert-new-after, cut, and paste (enabled only when the clipboard
 *     holds a cut note).
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
	onInsertAfter: () => void;
	onCut: () => void;
	onPaste: () => void;
	/** Whether the paste button should be enabled (clipboard has a cut note). */
	canPaste: boolean;
	/** Title of the currently cut note, for the paste button's tooltip. */
	cutTitle: string | null;
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
			onNavigate: () => {},
			onInsertAfter: () => {},
			onCut: () => {},
			onPaste: () => {},
			canPaste: false,
			cutTitle: null
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
						return buildDecorations(state.doc, storage);
					}
				}
			})
		];
	}
});

function buildDecorations(doc: PMNode, storage: SlipNoteArrowsStorage): DecorationSet {
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
			makeArrowFactory('prev', '이전', prev.target, () => storage.onNavigate),
			{
				side: -1,
				ignoreSelection: true,
				key: `slip-prev-${prev.target ?? 'none'}`
			}
		)
	);

	// Chain-edit action cluster between the arrows. Recreated when canPaste
	// / cutTitle change so the paste button's disabled state stays fresh.
	decorations.push(
		Decoration.widget(
			carrier.offset + 1,
			makeActionsFactory(storage),
			{
				side: 0,
				ignoreSelection: true,
				key: `slip-actions-${storage.canPaste ? 1 : 0}-${storage.cutTitle ?? ''}`
			}
		)
	);

	decorations.push(
		Decoration.widget(
			carrier.offset + carrier.block.nodeSize - 1,
			makeArrowFactory('next', '다음', next.target, () => storage.onNavigate),
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

/**
 * Build the action-button cluster (insert-after / cut / paste). Buttons
 * read the live storage refs at click time so handler replacements via the
 * editor's $effect take effect without rebuilding the decoration.
 */
function makeActionsFactory(storage: SlipNoteArrowsStorage): () => HTMLElement {
	return () => {
		const wrap = document.createElement('span');
		wrap.className = 'slipnote-actions';
		wrap.contentEditable = 'false';

		const make = (
			action: 'insert' | 'cut' | 'paste',
			ariaLabel: string,
			tooltip: string,
			svg: string,
			disabled: boolean,
			onClick: () => void
		) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = `slipnote-action slipnote-action-${action}`;
			btn.contentEditable = 'false';
			btn.setAttribute('aria-label', ariaLabel);
			btn.title = tooltip;
			btn.disabled = disabled;
			btn.innerHTML = svg;
			btn.addEventListener('mousedown', (e) => {
				e.preventDefault();
			});
			btn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (btn.disabled) return;
				onClick();
			});
			wrap.appendChild(btn);
		};

		make(
			'insert',
			'다음 슬립노트 추가',
			'다음 슬립노트 추가',
			'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
			false,
			() => storage.onInsertAfter()
		);

		make(
			'cut',
			'잘라내기',
			'이 슬립노트를 체인에서 잘라내기',
			'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
			false,
			() => storage.onCut()
		);

		const pasteTooltip = storage.canPaste
			? `"${storage.cutTitle ?? ''}" 붙여넣기`
			: '잘라낸 슬립노트가 없습니다';
		make(
			'paste',
			'붙여넣기',
			pasteTooltip,
			'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
			!storage.canPaste,
			() => storage.onPaste()
		);

		return wrap;
	};
}
