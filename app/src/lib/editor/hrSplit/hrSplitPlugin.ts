import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { assignColumns, type BlockKind, type ColumnRole } from './assignColumns.js';

interface PluginState {
	activeOrdinals: Set<number>;
}

interface ToggleMeta {
	toggle: number;
}

interface ReplaceMeta {
	replace: ReadonlyArray<number>;
}

type Meta = ToggleMeta | ReplaceMeta;

function isToggle(m: Meta): m is ToggleMeta {
	return typeof (m as ToggleMeta).toggle === 'number';
}
function isReplace(m: Meta): m is ReplaceMeta {
	return Array.isArray((m as ReplaceMeta).replace);
}

export const hrSplitPluginKey = new PluginKey<PluginState>('tomboyHrSplit');

export interface HrSplitOptions {
	onChange?: (active: ReadonlySet<number>) => void;
}

/**
 * A top-level child is a virtual HR if it's a paragraph whose entire text
 * content is 3+ dashes (trimmed). This is the Tomboy convention for a
 * horizontal divider — it round-trips through the .note XML as ordinary
 * paragraph text and is rendered as a line via decoration.
 */
export function isDashParagraph(node: PMNode): boolean {
	if (node.type.name !== 'paragraph') return false;
	const text = node.textContent.trim();
	return /^-{3,}$/.test(text);
}

function describeTopLevel(doc: PMNode): {
	kinds: BlockKind[];
	topLevelPositions: number[];
} {
	const kinds: BlockKind[] = [];
	const topLevelPositions: number[] = [];
	doc.forEach((node, offset) => {
		topLevelPositions.push(offset);
		kinds.push(isDashParagraph(node) ? 'hr' : 'block');
	});
	return { kinds, topLevelPositions };
}

/**
 * Find the top-level child index whose range contains `pos`. Returns -1
 * if `pos` is outside the doc.
 */
export function topLevelIndexAtPos(doc: PMNode, pos: number): number {
	let result = -1;
	let cursor = 0;
	doc.forEach((node, offset, idx) => {
		const end = offset + node.nodeSize;
		if (result < 0 && pos >= offset && pos < end) {
			result = idx;
		}
		cursor = end;
	});
	void cursor;
	return result;
}

function countHrMarkers(doc: PMNode): number {
	let n = 0;
	doc.forEach(node => {
		if (isDashParagraph(node)) n++;
	});
	return n;
}

/**
 * Compute per-block grid placement. Returns inline-style strings keyed by
 * top-level index. Layout uses a 3-column grid: column 1 = left, column 2
 * = divider track, column 3 = right. Full-width blocks span 1 / -1.
 *
 * Rows are assigned sequentially. A split (left segment + divider + right
 * segment) occupies max(leftCount, rightCount, 1) rows; the divider is
 * placed at grid-column 2 with `grid-row: start / span span`.
 */
export function computeGridStyles(
	roles: ColumnRole[]
): { styleFor: (string | null)[]; hasSplit: boolean } {
	const styleFor: (string | null)[] = new Array(roles.length).fill(null);
	let row = 1;
	let hasSplit = false;
	let i = 0;
	while (i < roles.length) {
		const r = roles[i];
		if (r === 'left' || r === 'divider' || r === 'right') {
			hasSplit = true;
			// Identify the contiguous left run.
			const leftStart = i;
			let leftEnd = i;
			while (leftEnd < roles.length && roles[leftEnd] === 'left') leftEnd++;
			// Divider sits at leftEnd (assignColumns guarantees this when there's a left segment).
			const dividerIdx = leftEnd;
			const hasDivider = dividerIdx < roles.length && roles[dividerIdx] === 'divider';
			const rightStart = hasDivider ? dividerIdx + 1 : leftEnd;
			let rightEnd = rightStart;
			while (rightEnd < roles.length && roles[rightEnd] === 'right') rightEnd++;

			const leftCount = leftEnd - leftStart;
			const rightCount = rightEnd - rightStart;
			const span = Math.max(leftCount, rightCount, 1);

			for (let k = 0; k < leftCount; k++) {
				styleFor[leftStart + k] = `grid-column:1;grid-row:${row + k};`;
			}
			for (let k = 0; k < rightCount; k++) {
				styleFor[rightStart + k] = `grid-column:3;grid-row:${row + k};`;
			}
			if (hasDivider) {
				styleFor[dividerIdx] = `grid-column:2;grid-row:${row} / span ${span};`;
			}
			row += span;
			i = rightEnd;
		} else {
			// full, plain-hr → full width row.
			styleFor[i] = `grid-column:1 / -1;grid-row:${row};`;
			row++;
			i++;
		}
	}
	return { styleFor, hasSplit };
}

function roleClasses(role: ColumnRole, isHr: boolean): string {
	const classes: string[] = [];
	if (isHr) classes.push('tomboy-hr-marker');
	switch (role) {
		case 'left':
			classes.push('tomboy-hr-split-left');
			break;
		case 'right':
			classes.push('tomboy-hr-split-right');
			break;
		case 'divider':
			classes.push('tomboy-hr-split-divider', 'tomboy-hr-marker-active');
			break;
		case 'plain-hr':
		case 'full':
		default:
			break;
	}
	return classes.join(' ');
}

function buildDecorations(doc: PMNode, active: ReadonlySet<number>): DecorationSet {
	const { kinds, topLevelPositions } = describeTopLevel(doc);
	const roles = assignColumns({ kinds, activeOrdinals: active });
	const { styleFor, hasSplit } = computeGridStyles(roles);

	const decos: Decoration[] = [];
	for (let i = 0; i < kinds.length; i++) {
		const isHr = kinds[i] === 'hr';
		const cls = roleClasses(roles[i], isHr);
		const style = hasSplit ? styleFor[i] : null;
		if (!cls && !style) continue;
		const from = topLevelPositions[i];
		const node = doc.child(i);
		const attrs: Record<string, string> = {};
		if (cls) attrs.class = cls;
		if (style) attrs.style = style;
		decos.push(Decoration.node(from, from + node.nodeSize, attrs));
	}
	return DecorationSet.create(doc, decos);
}

function reconcileActiveAgainstDoc(
	doc: PMNode,
	active: ReadonlySet<number>
): { changed: boolean; next: Set<number> } {
	const hrCount = countHrMarkers(doc);
	const next = new Set<number>();
	let changed = false;
	for (const ord of active) {
		if (ord < hrCount) next.add(ord);
		else changed = true;
	}
	return { changed, next };
}

/** Find the HR-marker ordinal whose top-level index is `topIdx`, or -1. */
function ordinalOfTopIndex(doc: PMNode, topIdx: number): number {
	let ord = 0;
	let found = -1;
	doc.forEach((node, _offset, idx) => {
		if (found >= 0) return;
		if (isDashParagraph(node)) {
			if (idx === topIdx) found = ord;
			ord++;
		}
	});
	return found;
}

export function createHrSplitPlugin(options: HrSplitOptions = {}): Plugin {
	return new Plugin<PluginState>({
		key: hrSplitPluginKey,
		state: {
			init(): PluginState {
				return { activeOrdinals: new Set() };
			},
			apply(tr: Transaction, prev: PluginState, _oldState, newState): PluginState {
				const meta = tr.getMeta(hrSplitPluginKey) as Meta | undefined;
				let next = prev.activeOrdinals;
				let cameFromReplace = false;

				if (meta) {
					if (isReplace(meta)) {
						next = new Set(
							meta.replace.filter(n => Number.isInteger(n) && n >= 0)
						);
						cameFromReplace = true;
					} else if (isToggle(meta)) {
						next = new Set(prev.activeOrdinals);
						if (next.has(meta.toggle)) next.delete(meta.toggle);
						else next.add(meta.toggle);
					}
				}

				let prunedByDoc = false;
				if (tr.docChanged) {
					const { changed, next: reconciled } = reconcileActiveAgainstDoc(
						newState.doc,
						next
					);
					if (changed) {
						next = reconciled;
						prunedByDoc = true;
					}
				}

				if (next === prev.activeOrdinals) return prev;
				if (!cameFromReplace || prunedByDoc) {
					queueMicrotask(() => options.onChange?.(next));
				}
				return { activeOrdinals: next };
			}
		},
		props: {
			decorations(state: EditorState) {
				const s = hrSplitPluginKey.getState(state);
				if (!s) return null;
				return buildDecorations(state.doc, s.activeOrdinals);
			},
			attributes(state: EditorState): Record<string, string> {
				const s = hrSplitPluginKey.getState(state);
				if (!s || s.activeOrdinals.size === 0) return {};
				return { class: 'tomboy-hr-split-active' };
			},
			handleClick(view, pos, event) {
				if (!(event.ctrlKey || event.metaKey)) return false;
				const doc = view.state.doc;
				const topIdx = topLevelIndexAtPos(doc, pos);
				if (topIdx < 0) return false;
				const child = doc.child(topIdx);
				if (!isDashParagraph(child)) return false;
				const ordinal = ordinalOfTopIndex(doc, topIdx);
				if (ordinal < 0) return false;
				event.preventDefault();
				view.dispatch(
					view.state.tr.setMeta(hrSplitPluginKey, { toggle: ordinal })
				);
				return true;
			}
		}
	});
}

export function getActiveOrdinals(state: EditorState): ReadonlySet<number> {
	const s = hrSplitPluginKey.getState(state);
	return s?.activeOrdinals ?? new Set();
}
