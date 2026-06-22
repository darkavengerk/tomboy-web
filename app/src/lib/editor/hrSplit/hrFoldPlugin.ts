import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { assignSections, computeBoxRegion } from './assignSections.js';
import {
	describeTopLevel,
	topLevelIndexAtPos,
	HEADER_COUNT
} from './hrSplitPlugin.js';
import {
	hrFoldPluginKey,
	hrSplitPluginKey,
	type HrFoldPluginState
} from './pluginKeys.js';

export { hrFoldPluginKey };

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

export interface HrFoldOptions {
	/** Fired after every user-driven state change (toggle or doc-prune)
	 *  with the new and previous folded sets. NOT called for `replace`
	 *  meta (note-load) since the host is already in sync with the
	 *  persisted state. */
	onChange?: (folded: ReadonlySet<number>, prev: ReadonlySet<number>) => void;
}

/**
 * HR fold plugin — collapses the content section below an HR marker.
 *
 * Section model: each post-header HR marker owns the blocks after it up
 * to the next HR (or end of doc). See assignSections.ts. Folding a
 * section clamps its first block to one visual line and hides the rest.
 *
 * Toggle gestures: the +/− widget button on the HR line, or a plain
 * (modifier-free) click anywhere on the HR line itself (handleClick).
 * Ctrl/Cmd+click stays reserved for the split toggle.
 *
 * Mutual exclusion with hrSplit (나란히 보기):
 * - While the split layout is active (any active column divider), this
 *   plugin renders NO decorations at all — fold buttons disappear and
 *   folded sections temporarily show expanded. Fold state itself is
 *   preserved (inert) and comes back when the split is deactivated.
 * - The reverse direction (folded sections block the split toggle) is
 *   enforced in hrSplitPlugin's handleClick.
 *
 * Like hrSplit, this plugin only ever attaches attribute decorations to
 * existing top-level blocks plus inline widget buttons inside the HR
 * marker paragraphs. It never restructures the DOM (no NodeViews, no
 * wrappers) — see the tomboy-hrsplit skill for why.
 */

function reconcileFoldedAgainstDoc(
	doc: PMNode,
	folded: ReadonlySet<number>
): { changed: boolean; next: Set<number> } {
	const { kinds } = describeTopLevel(doc);
	const { hrCount } = assignSections({ kinds, headerCount: HEADER_COUNT });
	const next = new Set<number>();
	let changed = false;
	for (const ord of folded) {
		if (ord < hrCount) next.add(ord);
		else changed = true;
	}
	return { changed, next };
}

function buildFoldDecorations(
	doc: PMNode,
	folded: ReadonlySet<number>
): DecorationSet {
	const { kinds, topLevelPositions } = describeTopLevel(doc);
	const { roles } = assignSections({ kinds, headerCount: HEADER_COUNT });
	// Section box frame — a 1×N table rectangle around the content `---`
	// sections, drawn with per-block borders (no DOM wrapping; PM-safe).
	// Independent of fold state except for `bottom` (last visible block).
	const box = computeBoxRegion(roles, folded);

	const decos: Decoration[] = [];
	for (let i = 0; i < roles.length; i++) {
		const r = roles[i];
		const from = topLevelPositions[i];
		const node = doc.child(i);
		const to = from + node.nodeSize;

		// Box classes for every block inside the region. `tomboy-hr-box`
		// carries the side borders + collapsed margins; the first HR is the
		// top edge, the last visible block the bottom edge.
		const boxClasses: string[] = [];
		if (box.top >= 0 && i >= box.top && i <= box.end) {
			boxClasses.push('tomboy-hr-box');
			if (i === box.top) boxClasses.push('tomboy-hr-box-top');
			if (i === box.bottom) boxClasses.push('tomboy-hr-box-bottom');
		}

		if (r.role === 'hr') {
			if (r.sectionEmpty) {
				// An empty `---` sitting between two non-empty sections is still
				// inside the box (it just renders as an extra divider line); it
				// gets the side borders but no fold affordance.
				if (boxClasses.length) {
					decos.push(
						Decoration.node(from, to, { class: boxClasses.join(' ') })
					);
				}
				continue;
			}
			const isFolded = folded.has(r.ord);
			const ord = r.ord;
			// Clickable-line affordance: the whole HR line toggles the fold
			// (plain click, handled in handleClick below). The class only
			// carries cursor/hover styling — PM merges it with the
			// `tomboy-hr-marker` class the split plugin puts on the same node.
			decos.push(
				Decoration.node(from, to, {
					class: [
						'tomboy-hr-fold-line' +
							(isFolded ? ' tomboy-hr-fold-line-folded' : ''),
						...boxClasses
					].join(' ')
				})
			);
			// Widget button inside the HR marker paragraph (pos + 1 = just
			// inside the block). The HR marker is never hidden or clamped,
			// so the button can't be clipped by the fold CSS. The widget's
			// toDOM callback receives the live EditorView, which the click
			// handler uses to dispatch the toggle — no external plumbing.
			decos.push(
				Decoration.widget(
					from + 1,
					view => {
						const btn = document.createElement('button');
						btn.type = 'button';
						btn.className =
							'tomboy-hr-fold-btn' +
							(isFolded ? ' tomboy-hr-fold-btn-folded' : '');
						btn.textContent = isFolded ? '+' : '−';
						btn.title = isFolded ? '섹션 펼치기' : '섹션 접기';
						btn.setAttribute('aria-label', btn.title);
						btn.setAttribute('contenteditable', 'false');
						// mousedown preventDefault keeps the caret where it is —
						// clicking the button must not move the selection into
						// the HR marker paragraph.
						btn.addEventListener('mousedown', e => {
							e.preventDefault();
							e.stopPropagation();
						});
						btn.addEventListener('click', e => {
							e.preventDefault();
							e.stopPropagation();
							if (view.isDestroyed) return;
							view.dispatch(
								view.state.tr.setMeta(hrFoldPluginKey, { toggle: ord })
							);
						});
						return btn;
					},
					{
						side: -1,
						ignoreSelection: true,
						key: `tomboy-hr-fold-btn-${ord}-${isFolded ? 'folded' : 'open'}`
					}
				)
			);
			continue;
		}

		const contentClasses = [...boxClasses];
		if (r.role === 'first' && folded.has(r.section)) {
			contentClasses.push('tomboy-hr-fold-clamped');
		} else if (r.role === 'rest' && folded.has(r.section)) {
			contentClasses.push('tomboy-hr-fold-hidden');
		}
		if (contentClasses.length) {
			decos.push(
				Decoration.node(from, to, { class: contentClasses.join(' ') })
			);
		}
	}
	return DecorationSet.create(doc, decos);
}

export function createHrFoldPlugin(options: HrFoldOptions = {}): Plugin {
	return new Plugin<HrFoldPluginState>({
		key: hrFoldPluginKey,
		state: {
			init(): HrFoldPluginState {
				return { folded: new Set() };
			},
			apply(
				tr: Transaction,
				prev: HrFoldPluginState,
				_oldState,
				newState
			): HrFoldPluginState {
				const meta = tr.getMeta(hrFoldPluginKey) as Meta | undefined;
				let next = prev.folded;
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
						next = new Set(prev.folded);
						if (next.has(meta.toggle)) next.delete(meta.toggle);
						else next.add(meta.toggle);
						changed = true;
					}
				}

				let prunedByDoc = false;
				if (tr.docChanged) {
					const { changed: pruned, next: reconciled } =
						reconcileFoldedAgainstDoc(newState.doc, next);
					if (pruned) {
						next = reconciled;
						prunedByDoc = true;
						changed = true;
					}
				}

				if (!changed) return prev;
				if (!cameFromReplace || prunedByDoc) {
					const prevSnapshot = prev.folded;
					const nextSnapshot = next;
					queueMicrotask(() => options.onChange?.(nextSnapshot, prevSnapshot));
				}
				return { folded: next };
			}
		},
		props: {
			decorations(state: EditorState) {
				const s = hrFoldPluginKey.getState(state);
				if (!s) return null;
				// Mutual exclusion: while the split layout is active, fold is
				// completely inert — no buttons, no clamp/hide classes. The
				// split's grid placement assumes every block is visible.
				const split = hrSplitPluginKey.getState(state);
				if (split && split.activeOrdinals.size > 0) return null;
				return buildFoldDecorations(state.doc, s.folded);
			},
			attributes(state: EditorState): Record<string, string> {
				const s = hrFoldPluginKey.getState(state);
				const split = hrSplitPluginKey.getState(state);
				if (
					!s ||
					s.folded.size === 0 ||
					(split && split.activeOrdinals.size > 0)
				) {
					return {};
				}
				return { class: 'tomboy-hr-fold-active' };
			},
			handleClick(view, pos, event) {
				// Plain click on the HR line toggles the fold of its section.
				// Ctrl/Cmd is the split-toggle gesture — never claim it here.
				if (event.ctrlKey || event.metaKey) return false;
				const s = hrFoldPluginKey.getState(view.state);
				if (!s) return false;
				// Mutual exclusion: fold is inert while the split layout is
				// active (the HR line is a column divider then, and plain
				// pointerdown on it starts a width drag).
				const split = hrSplitPluginKey.getState(view.state);
				if (split && split.activeOrdinals.size > 0) return false;
				const doc = view.state.doc;
				const topIdx = topLevelIndexAtPos(doc, pos);
				if (topIdx < 0) return false;
				const { kinds } = describeTopLevel(doc);
				const { roles } = assignSections({ kinds, headerCount: HEADER_COUNT });
				const r = roles[topIdx];
				if (r.role !== 'hr' || r.sectionEmpty) return false;
				event.preventDefault();
				view.dispatch(
					view.state.tr.setMeta(hrFoldPluginKey, { toggle: r.ord })
				);
				return true;
			}
		}
	});
}

export function getFoldedOrdinals(state: EditorState): ReadonlySet<number> {
	const s = hrFoldPluginKey.getState(state);
	return s?.folded ?? new Set();
}
