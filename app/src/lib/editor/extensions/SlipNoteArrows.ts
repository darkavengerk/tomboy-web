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
 *   • Collapses block 3 (`다음:` line) and block 4 (the structurally-
 *     required trailing blank line) via `display: none` so the arrow pair
 *     occupies a single line and the user can't accidentally delete the
 *     blank line during editing.
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
	/**
	 * `replace` is true when the user held Ctrl/Cmd while clicking — the
	 * caller should close the source window and open the target in its
	 * place instead of cascading sideways.
	 */
	onNavigate: (target: string, direction: 'prev' | 'next', replace: boolean) => void;
	onInsertAfter: () => void;
	onCut: () => void;
	onConnect: () => void;
	onPaste: () => void;
	/** Whether the paste button should be enabled (clipboard has any entry). */
	canPaste: boolean;
	/** Title of the currently clipboarded note, for the paste button's tooltip. */
	clipboardTitle: string | null;
	/** Mode of the current clipboard entry, for tooltip + intent. */
	clipboardMode: 'cut' | 'connect' | null;
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
			onConnect: () => {},
			onPaste: () => {},
			canPaste: false,
			clipboardTitle: null,
			clipboardMode: null
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

	if (blocks.length < 5) return DecorationSet.empty;

	const prev = parseLabeledLine(blocks[2].block, '이전');
	const next = parseLabeledLine(blocks[3].block, '다음');

	// Both lines must be well-formed for the merged bar to make sense.
	// Otherwise leave the paragraphs untouched so the user can see what's
	// wrong.
	if (!prev || !next) return DecorationSet.empty;

	const decorations: Decoration[] = [];
	const carrier = blocks[2];
	const hidden = blocks[3];
	// Block 4 is the structurally-required blank line after `다음:`. Hide
	// it so the user can't drop the cursor on it and backspace away the
	// invariant — the slip-note format check refuses to splice a chain
	// whose blank-line separator is missing.
	const trailingBlank = blocks[4];

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

	// Chain-edit action cluster between the arrows. Recreated when the
	// clipboard state or the current note's TAIL-ness changes so the paste
	// button's disabled state + tooltip stays fresh.
	const isTail = next.target === null;
	decorations.push(
		Decoration.widget(
			carrier.offset + 1,
			makeActionsFactory(storage, isTail),
			{
				side: 0,
				ignoreSelection: true,
				key: `slip-actions-${storage.canPaste ? 1 : 0}-${storage.clipboardMode ?? ''}-${storage.clipboardTitle ?? ''}-${isTail ? 't' : 'm'}`
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

	// Hide the trailing blank line too, but only if it really IS a blank
	// paragraph — if the user has typed real content there (a malformed
	// slip note), leave it visible so the issue is recoverable.
	if (
		trailingBlank.block.type.name === 'paragraph' &&
		trailingBlank.block.content.size === 0
	) {
		decorations.push(
			Decoration.node(
				trailingBlank.offset,
				trailingBlank.offset + trailingBlank.block.nodeSize,
				{ class: 'slipnote-hidden-line' }
			)
		);
	}

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
	getHandler: () => (target: string, direction: 'prev' | 'next', replace: boolean) => void
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
			getHandler()(target, direction, e.ctrlKey || e.metaKey);
		});
		return btn;
	};
}

/**
 * Read the slip-note `이전` / `다음` link targets from the doc — used by
 * keyboard shortcuts that don't go through the click handler. Returns
 * `{ prev: null, next: null }` when the doc isn't a well-formed slip note.
 */
export function parseSlipNeighbors(doc: PMNode): {
	prev: string | null;
	next: string | null;
} {
	const blocks: { block: PMNode; offset: number }[] = [];
	doc.forEach((block, offset) => {
		blocks.push({ block, offset });
	});
	if (blocks.length < 4) return { prev: null, next: null };
	const prev = parseLabeledLine(blocks[2].block, '이전');
	const next = parseLabeledLine(blocks[3].block, '다음');
	if (!prev || !next) return { prev: null, next: null };
	return { prev: prev.target, next: next.target };
}

/**
 * Build the action-button cluster (insert-after / cut / connect / paste).
 * Buttons read the live storage refs at click time so handler replacements
 * via the editor's $effect take effect without rebuilding the decoration.
 *
 * `isTail` reflects whether this note's 다음 is empty — used to disable
 * the paste button in connect mode since connectAfter refuses non-TAIL
 * targets.
 */
function makeActionsFactory(
	storage: SlipNoteArrowsStorage,
	isTail: boolean
): () => HTMLElement {
	return () => {
		const wrap = document.createElement('span');
		wrap.className = 'slipnote-actions';
		wrap.contentEditable = 'false';

		const make = (
			action: 'insert' | 'cut' | 'connect' | 'paste',
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

		make(
			'connect',
			'다른 곳에 연결',
			'이 슬립노트와 그 이후 체인을 다른 곳에 연결 (이전 링크만 끊김)',
			'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
			false,
			() => storage.onConnect()
		);

		// The paste button handles both clipboard modes. Cut-mode paste
		// splices into the middle (no TAIL constraint). Connect-mode paste
		// appends the source-plus-downstream at the end and requires a
		// TAIL target — so we grey the button out on non-TAIL notes with
		// an explanatory tooltip instead of letting the op throw at click
		// time.
		const mode = storage.clipboardMode;
		const title = storage.clipboardTitle ?? '';
		let pasteTooltip: string;
		let pasteDisabled: boolean;
		if (!storage.canPaste || mode === null) {
			pasteTooltip = '잘라내거나 연결한 슬립노트가 없습니다';
			pasteDisabled = true;
		} else if (mode === 'cut') {
			pasteTooltip = `"${title}" 이 노트 뒤에 붙여넣기 (잘라내기)`;
			pasteDisabled = false;
		} else if (mode === 'connect' && !isTail) {
			pasteTooltip =
				`"${title}" 연결: 이 노트의 다음 링크가 이미 있어 끝(TAIL)이 아닙니다`;
			pasteDisabled = true;
		} else {
			pasteTooltip = `"${title}" 이 노트 뒤에 연결`;
			pasteDisabled = false;
		}
		make(
			'paste',
			mode === 'connect' ? '연결 (붙여넣기)' : '붙여넣기',
			pasteTooltip,
			'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
			pasteDisabled,
			() => storage.onPaste()
		);

		return wrap;
	};
}
