import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import {
	assignColumns,
	computeGridStyles,
	type BlockKind
} from './assignColumns.js';

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
 * A top-level child is a virtual HR marker if it's a paragraph whose
 * entire text content (trimmed) is 3+ dashes. The first child is excluded
 * — the title paragraph always renders as a title.
 */
export function isDashParagraph(node: PMNode): boolean {
	if (node.type.name !== 'paragraph') return false;
	const text = node.textContent.trim();
	return /^-{3,}$/.test(text);
}

/** Number of leading top-level children excluded from the split layout.
 *  These are the title (index 0) and the subtitle/date line (index 1),
 *  which always render full-width above the split area. */
const HEADER_COUNT = 2;

function describeTopLevel(doc: PMNode): {
	kinds: BlockKind[];
	topLevelPositions: number[];
} {
	const kinds: BlockKind[] = [];
	const topLevelPositions: number[] = [];
	doc.forEach((node, offset, idx) => {
		topLevelPositions.push(offset);
		const isHrCandidate = idx >= HEADER_COUNT && isDashParagraph(node);
		kinds.push(isHrCandidate ? 'hr' : 'block');
	});
	return { kinds, topLevelPositions };
}

/** Find the top-level child index whose range contains `pos`. -1 if none. */
export function topLevelIndexAtPos(doc: PMNode, pos: number): number {
	let result = -1;
	doc.forEach((node, offset, idx) => {
		const end = offset + node.nodeSize;
		if (result < 0 && pos >= offset && pos < end) {
			result = idx;
		}
	});
	return result;
}

function countHrMarkers(doc: PMNode): number {
	const { kinds } = describeTopLevel(doc);
	let n = 0;
	for (const k of kinds) if (k === 'hr') n++;
	return n;
}

/** Find the HR-marker ordinal whose top-level index is `topIdx`, or -1. */
function ordinalOfTopIndex(doc: PMNode, topIdx: number): number {
	const { kinds } = describeTopLevel(doc);
	if (topIdx < 0 || topIdx >= kinds.length) return -1;
	if (kinds[topIdx] !== 'hr') return -1;
	let ord = 0;
	for (let i = 0; i < topIdx; i++) {
		if (kinds[i] === 'hr') ord++;
	}
	return ord;
}

interface Layout {
	decorations: DecorationSet;
	template: string | null;
}

function buildLayout(doc: PMNode, active: ReadonlySet<number>): Layout {
	const { kinds, topLevelPositions } = describeTopLevel(doc);
	const { placements, totalColumns } = assignColumns({
		kinds,
		activeOrdinals: active,
		headerCount: HEADER_COUNT
	});
	const { styleFor, template } = computeGridStyles(placements, totalColumns);

	const decos: Decoration[] = [];
	for (let i = 0; i < kinds.length; i++) {
		const isHr = kinds[i] === 'hr';
		const p = placements[i];
		const classes: string[] = [];
		if (isHr) classes.push('tomboy-hr-marker');
		if (p.role === 'v-divider') {
			classes.push('tomboy-hr-split-divider', 'tomboy-hr-marker-active');
		}
		const style = styleFor[i];
		if (classes.length === 0 && !style) continue;
		const from = topLevelPositions[i];
		const node = doc.child(i);
		const attrs: Record<string, string> = {};
		if (classes.length > 0) attrs.class = classes.join(' ');
		if (style) attrs.style = style;
		decos.push(Decoration.node(from, from + node.nodeSize, attrs));
	}
	return { decorations: DecorationSet.create(doc, decos), template };
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
				return buildLayout(state.doc, s.activeOrdinals).decorations;
			},
			attributes(state: EditorState): Record<string, string> {
				const s = hrSplitPluginKey.getState(state);
				if (!s || s.activeOrdinals.size === 0) return {};
				const { template } = buildLayout(state.doc, s.activeOrdinals);
				const attrs: Record<string, string> = { class: 'tomboy-hr-split-active' };
				if (template) attrs.style = `grid-template-columns:${template};`;
				return attrs;
			},
			handleClick(view, pos, event) {
				if (!(event.ctrlKey || event.metaKey)) return false;
				const doc = view.state.doc;
				const topIdx = topLevelIndexAtPos(doc, pos);
				if (topIdx < 0) return false;
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
