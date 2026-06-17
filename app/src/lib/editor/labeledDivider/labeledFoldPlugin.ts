import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import {
	assignAccordion,
	type AccordionBlockKind,
	type AccordionMember
} from './assignAccordion.js';
import { parseLabeledDivider } from './parseLabeledDivider.js';
import { isDashParagraph, HEADER_COUNT } from '../hrSplit/hrSplitPlugin.js';
import { hrSplitPluginKey } from '../hrSplit/pluginKeys.js';

export interface LabeledFoldPluginState {
	/** Labeled-divider ordinals that are "focused" (open while group
	 *  siblings fold). Invariant: at most one per group. */
	focused: Set<number>;
}

export const labeledFoldPluginKey = new PluginKey<LabeledFoldPluginState>(
	'tomboyLabeledFold'
);

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

export interface LabeledFoldOptions {
	/** Fired after every user-driven change (toggle or doc-prune). NOT
	 *  called for `replace` (note-load); host is already in sync then. */
	onChange?: (focused: ReadonlySet<number>, prev: ReadonlySet<number>) => void;
}

/** Classify every top-level child for the accordion model. */
function describeAccordion(doc: PMNode): {
	kinds: AccordionBlockKind[];
	positions: number[];
} {
	const kinds: AccordionBlockKind[] = [];
	const positions: number[] = [];
	doc.forEach((node, offset) => {
		positions.push(offset);
		if (isDashParagraph(node)) {
			kinds.push('hr');
		} else if (
			node.type.name === 'bulletList' ||
			node.type.name === 'orderedList'
		) {
			kinds.push('list');
		} else if (
			node.type.name === 'paragraph' &&
			parseLabeledDivider(node.textContent) !== null
		) {
			kinds.push('divider');
		} else {
			kinds.push('other');
		}
	});
	return { kinds, positions };
}

/** The single focused ordinal within `group`, or null. */
function focusedInGroup(
	focused: ReadonlySet<number>,
	members: AccordionMember[],
	group: number
): number | null {
	for (const ord of focused) {
		const m = members.find(x => x.ord === ord);
		if (m && m.group === group) return ord;
	}
	return null;
}

/** Apply a toggle: focus / cycle-to-next / jump. Returns null when the
 *  toggle targets a non-member or a <2-member group (ignored). */
function applyToggle(
	doc: PMNode,
	prev: ReadonlySet<number>,
	toggleOrd: number
): Set<number> | null {
	const { kinds } = describeAccordion(doc);
	const { members, memberCountByGroup } = assignAccordion({
		kinds,
		headerCount: HEADER_COUNT
	});
	const m = members.find(x => x.ord === toggleOrd && x.isListBearing);
	if (!m) return null;
	if ((memberCountByGroup.get(m.group) ?? 0) < 2) return null;
	// members are built in doc order → ascending ord within the group.
	const groupMembers = members.filter(
		x => x.group === m.group && x.isListBearing
	);
	const cur = focusedInGroup(prev, members, m.group);
	const next = new Set(prev);
	for (const gm of groupMembers) next.delete(gm.ord);
	if (cur === m.ord) {
		const idx = groupMembers.findIndex(x => x.ord === m.ord);
		next.add(groupMembers[(idx + 1) % groupMembers.length].ord);
	} else {
		next.add(m.ord);
	}
	return next;
}

/** Drop focus ordinals that are no longer list-bearing members, and keep
 *  at most one per group (lowest ord wins). */
function reconcileAgainstDoc(
	doc: PMNode,
	focused: ReadonlySet<number>
): { changed: boolean; next: Set<number> } {
	const { kinds } = describeAccordion(doc);
	const { members } = assignAccordion({ kinds, headerCount: HEADER_COUNT });
	const validByOrd = new Map<number, AccordionMember>();
	for (const m of members) if (m.isListBearing) validByOrd.set(m.ord, m);
	const seenGroup = new Set<number>();
	const next = new Set<number>();
	let changed = false;
	for (const ord of [...focused].sort((a, b) => a - b)) {
		const m = validByOrd.get(ord);
		if (!m) {
			changed = true;
			continue;
		}
		if (seenGroup.has(m.group)) {
			changed = true;
			continue;
		}
		seenGroup.add(m.group);
		next.add(ord);
	}
	return { changed, next };
}

function buildDecorations(
	doc: PMNode,
	focused: ReadonlySet<number>
): DecorationSet {
	const { kinds, positions } = describeAccordion(doc);
	const { members, memberCountByGroup } = assignAccordion({
		kinds,
		headerCount: HEADER_COUNT
	});
	const decos: Decoration[] = [];
	for (const m of members) {
		if (!m.isListBearing) continue;
		if ((memberCountByGroup.get(m.group) ?? 0) < 2) continue;
		const f = focusedInGroup(focused, members, m.group);
		const isOpen = f === null || f === m.ord;
		const dividerFrom = positions[m.index];
		const ord = m.ord;
		decos.push(
			Decoration.widget(
				dividerFrom + 1,
				view => {
					const btn = document.createElement('button');
					btn.type = 'button';
					btn.className =
						'tomboy-labeled-fold-btn' +
						(isOpen ? '' : ' tomboy-labeled-fold-btn-folded');
					btn.textContent = isOpen ? '−' : '+';
					btn.title = isOpen ? '다음 리스트 보기' : '이 리스트 펼치기';
					btn.setAttribute('aria-label', btn.title);
					btn.setAttribute('contenteditable', 'false');
					btn.addEventListener('mousedown', e => {
						e.preventDefault();
						e.stopPropagation();
					});
					btn.addEventListener('click', e => {
						e.preventDefault();
						e.stopPropagation();
						if (view.isDestroyed) return;
						view.dispatch(
							view.state.tr.setMeta(labeledFoldPluginKey, { toggle: ord })
						);
					});
					return btn;
				},
				{
					side: -1,
					ignoreSelection: true,
					key: `tomboy-labeled-fold-btn-${ord}-${isOpen ? 'open' : 'folded'}`
				}
			)
		);
		if (!isOpen) {
			for (const li of m.listIndices) {
				const from = positions[li];
				const node = doc.child(li);
				decos.push(
					Decoration.node(from, from + node.nodeSize, {
						class: 'tomboy-labeled-fold-hidden'
					})
				);
			}
		}
	}
	return DecorationSet.create(doc, decos);
}

/**
 * Labeled-divider list accordion plugin.
 *
 * `텍스트 ---` dividers whose next block is a list become foldable
 * members. Members are grouped by plain `---` HR markers; within a group
 * at most one member's list shows at a time (focus). Toggling the open
 * member cycles to the next (wrapping); toggling a closed member jumps.
 * Default (no focus) shows all lists.
 *
 * Toggle is via the `+/−` widget button only (no line-click / handleClick)
 * so the divider's editable label text stays clickable.
 *
 * Inert while hrSplit is active (the split's grid placement assumes every
 * block is visible). Decoration-only — never restructures the DOM.
 */
export function createLabeledFoldPlugin(
	options: LabeledFoldOptions = {}
): Plugin {
	return new Plugin<LabeledFoldPluginState>({
		key: labeledFoldPluginKey,
		state: {
			init(): LabeledFoldPluginState {
				return { focused: new Set() };
			},
			apply(
				tr: Transaction,
				prev: LabeledFoldPluginState,
				_old,
				newState
			): LabeledFoldPluginState {
				const meta = tr.getMeta(labeledFoldPluginKey) as Meta | undefined;
				let next = prev.focused;
				let changed = false;
				let cameFromReplace = false;

				if (meta) {
					if (isReplace(meta)) {
						next = new Set(
							meta.replace.filter(n => Number.isInteger(n) && n >= 0)
						);
						changed = true;
						cameFromReplace = true;
					} else if (isToggle(meta)) {
						const toggled = applyToggle(newState.doc, prev.focused, meta.toggle);
						if (toggled) {
							next = toggled;
							changed = true;
						}
					}
				}

				let prunedByDoc = false;
				// Skip reconcile for editor-appended normalization transactions
				// (e.g. StarterKit's trailing-node insertion fired right after a
				// `replace` note-load). These carry no user-driven structural
				// change, so pruning here would prematurely drop a just-seeded
				// focus set before the matching member is even parsed. Real user
				// edits are never appended transactions, so they still reconcile.
				const isAppended =
					tr.getMeta('appendedTransaction') !== undefined;
				if (tr.docChanged && !isAppended) {
					const { changed: pruned, next: rec } = reconcileAgainstDoc(
						newState.doc,
						next
					);
					if (pruned) {
						next = rec;
						prunedByDoc = true;
						changed = true;
					}
				}

				if (!changed) return prev;
				if (!cameFromReplace || prunedByDoc) {
					const prevSnapshot = prev.focused;
					const nextSnapshot = next;
					queueMicrotask(() => options.onChange?.(nextSnapshot, prevSnapshot));
				}
				return { focused: next };
			}
		},
		props: {
			decorations(state: EditorState) {
				const s = labeledFoldPluginKey.getState(state);
				if (!s) return null;
				// Inert while the column split is active.
				const split = hrSplitPluginKey.getState(state);
				if (split && split.activeOrdinals.size > 0) return null;
				return buildDecorations(state.doc, s.focused);
			}
		}
	});
}

export function getFocusedOrdinals(state: EditorState): ReadonlySet<number> {
	const s = labeledFoldPluginKey.getState(state);
	return s?.focused ?? new Set();
}
