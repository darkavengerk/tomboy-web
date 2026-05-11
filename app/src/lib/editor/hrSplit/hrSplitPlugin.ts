import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { assignColumns, type BlockKind, type ColumnRole } from './assignColumns.js';

interface PluginState {
	/** 0-based ordinals (among top-level HR children) that are split-active. */
	activeOrdinals: Set<number>;
}

interface ToggleMeta {
	toggle: number;
}

interface ReplaceMeta {
	/** Wholesale replacement; used when the doc is swapped to a different
	 *  note and the host loads persisted state from storage. */
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
	/** Called after every state change that mutates activeOrdinals so the
	 *  host can persist the new set (typically to localStorage keyed by
	 *  the current note's guid). */
	onChange?: (active: ReadonlySet<number>) => void;
}

function describeTopLevel(doc: PMNode): {
	kinds: BlockKind[];
	topLevelPositions: number[];
} {
	const kinds: BlockKind[] = [];
	const topLevelPositions: number[] = [];
	doc.forEach((node, offset) => {
		topLevelPositions.push(offset);
		kinds.push(node.type.name === 'horizontalRule' ? 'hr' : 'block');
	});
	return { kinds, topLevelPositions };
}

function roleClass(role: ColumnRole): string | null {
	switch (role) {
		case 'left':
			return 'tomboy-hr-split-left';
		case 'right':
			return 'tomboy-hr-split-right';
		case 'divider':
			return 'tomboy-hr-split-divider';
		case 'plain-hr':
		case 'full':
		default:
			return null;
	}
}

function buildDecorations(doc: PMNode, active: ReadonlySet<number>): DecorationSet {
	const { kinds, topLevelPositions } = describeTopLevel(doc);
	// Segment index that activates a split equals the HR ordinal, since
	// segment i ends at HR i in assignColumns' addressing.
	const roles = assignColumns({ kinds, activeOrdinals: active });

	const decos: Decoration[] = [];
	for (let i = 0; i < kinds.length; i++) {
		const cls = roleClass(roles[i]);
		if (!cls) continue;
		const from = topLevelPositions[i];
		const node = doc.child(i);
		decos.push(Decoration.node(from, from + node.nodeSize, { class: cls }));
	}
	return DecorationSet.create(doc, decos);
}

function reconcileActiveAgainstDoc(
	doc: PMNode,
	active: ReadonlySet<number>
): { changed: boolean; next: Set<number> } {
	// Drop any active ordinal that no longer corresponds to an HR (e.g.
	// the user deleted the HR). Keeps localStorage from accumulating
	// stale entries forever.
	let hrCount = 0;
	doc.forEach(node => {
		if (node.type.name === 'horizontalRule') hrCount++;
	});
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
						next = new Set(meta.replace.filter(n => Number.isInteger(n) && n >= 0));
						cameFromReplace = true;
					} else if (isToggle(meta)) {
						next = new Set(prev.activeOrdinals);
						if (next.has(meta.toggle)) next.delete(meta.toggle);
						else next.add(meta.toggle);
					}
				}

				// On doc changes, prune ordinals that no longer point at an HR.
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
				// Don't echo a replace (loaded from storage) back to the host —
				// it would just rewrite the same value under the same key.
				// Do fire when the doc-change reconciliation actually pruned
				// something so the stale entry is cleaned out of storage.
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
			handleClickOn(view, _pos, node, nodePos, event, direct) {
				if (!direct) return false;
				if (node.type.name !== 'horizontalRule') return false;
				if (!(event.ctrlKey || event.metaKey)) return false;
				// Figure out which top-level HR this is by ordinal in the doc.
				const doc = view.state.doc;
				let ordinal = -1;
				let counter = 0;
				let found = false;
				doc.forEach((child, offset) => {
					if (found) return;
					if (child.type.name === 'horizontalRule') {
						if (offset === nodePos) {
							ordinal = counter;
							found = true;
						}
						counter++;
					}
				});
				if (ordinal < 0) return false;
				event.preventDefault();
				view.dispatch(view.state.tr.setMeta(hrSplitPluginKey, { toggle: ordinal }));
				return true;
			}
		}
	});
}

/** Convenience for tests / host integration. */
export function getActiveOrdinals(state: EditorState): ReadonlySet<number> {
	const s = hrSplitPluginKey.getState(state);
	return s?.activeOrdinals ?? new Set();
}
