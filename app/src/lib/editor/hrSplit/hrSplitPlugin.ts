import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
	assignColumns,
	computeLayoutHints,
	computeColumnGroups,
	type BlockKind,
	type ColumnGroup
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
	/** Fired after every state-changing transition with the new and previous
	 *  active sets. NOT called for `replace` meta (note-load) since the host
	 *  is already in sync with the persisted state. */
	onChange?: (active: ReadonlySet<number>, prev: ReadonlySet<number>) => void;
	/** Optional gate. When this returns `false`, the click handler ignores
	 *  Ctrl+click and the decoration pass treats activeOrdinals as empty
	 *  (so persisted column splits don't bleed into a disabled context).
	 *  The `tomboy-hr-marker` class still applies to `---` paragraphs so
	 *  they render as horizontal lines. */
	enabled?: () => boolean;
}

/** Class name on the per-column wrapper elements injected by the view()
 *  hook. These wrappers are NOT part of the ProseMirror document — they
 *  are presentation-only and must be torn down before PM mutates view.dom
 *  (otherwise PM's insertBefore/removeChild on a wrapped child throws). */
const COL_WRAPPER_CLASS = 'tomboy-hr-split-col';

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
	groups: ColumnGroup[];
}

function buildLayout(
	doc: PMNode,
	active: ReadonlySet<number>,
	enabled: boolean
): Layout {
	const { kinds, topLevelPositions } = describeTopLevel(doc);
	// When the feature is disabled (e.g., mobile), force activeOrdinals to
	// empty so all HR markers stay h-lines and no grid layout kicks in,
	// even if localStorage holds non-empty state from another context.
	const effectiveActive: ReadonlySet<number> = enabled ? active : new Set();
	const { placements, totalColumns } = assignColumns({
		kinds,
		activeOrdinals: effectiveActive,
		headerCount: HEADER_COUNT
	});
	const { styleFor, template } = computeLayoutHints(placements, totalColumns);
	const groups = totalColumns > 1 ? computeColumnGroups(placements) : [];

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
	return { decorations: DecorationSet.create(doc, decos), template, groups };
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

/** Remove every previously injected column wrapper, moving its children
 *  back to be direct children of view.dom in their original positions.
 *  Must run BEFORE ProseMirror mutates view.dom — PM's structural ops
 *  (insertBefore / removeChild on a node desc's dom) assume the desc's
 *  dom is a direct child of view.dom. */
function unwrapColumns(viewDom: HTMLElement): void {
	const wrappers = viewDom.querySelectorAll<HTMLElement>(
		`:scope > .${COL_WRAPPER_CLASS}`
	);
	wrappers.forEach(wrapper => {
		const parent = wrapper.parentNode;
		if (!parent) return;
		while (wrapper.firstChild) {
			parent.insertBefore(wrapper.firstChild, wrapper);
		}
		parent.removeChild(wrapper);
	});
}

/** Group consecutive top-level children that belong to the same content
 *  column into wrapper divs. Wrappers are flex columns (per CSS) so each
 *  column flows its content top-down independently — items in different
 *  columns no longer share a grid row, which is what the user perceives
 *  as "lines getting linked together" in the previous shared-row design. */
function wrapColumns(viewDom: HTMLElement, groups: ReadonlyArray<ColumnGroup>): void {
	if (groups.length === 0) return;
	// Snapshot direct children once — splice indices computed from this list
	// stay valid because we only re-parent these specific nodes, in order.
	const children = Array.from(viewDom.children) as HTMLElement[];
	for (const group of groups) {
		if (group.startIdx >= children.length || group.endIdx > children.length) {
			// Defensive: doc/DOM out of sync (e.g., between transactions). Skip.
			continue;
		}
		const first = children[group.startIdx];
		if (!first || first.parentNode !== viewDom) continue;
		const wrapper = document.createElement('div');
		wrapper.className = COL_WRAPPER_CLASS;
		wrapper.setAttribute('data-hr-col', String(group.col));
		// Grid track for column `c` is `2c - 1` (content tracks at odd
		// indices, divider tracks at even).
		wrapper.style.gridColumn = String(2 * group.col - 1);
		viewDom.insertBefore(wrapper, first);
		for (let i = group.startIdx; i < group.endIdx; i++) {
			const node = children[i];
			if (node) wrapper.appendChild(node);
		}
	}
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
					const prevSnapshot = prev.activeOrdinals;
					queueMicrotask(() => options.onChange?.(next, prevSnapshot));
				}
				return { activeOrdinals: next };
			}
		},
		props: {
			decorations(state: EditorState) {
				const s = hrSplitPluginKey.getState(state);
				if (!s) return null;
				const enabled = options.enabled?.() ?? true;
				return buildLayout(state.doc, s.activeOrdinals, enabled).decorations;
			},
			attributes(state: EditorState): Record<string, string> {
				const s = hrSplitPluginKey.getState(state);
				const enabled = options.enabled?.() ?? true;
				if (!s || !enabled || s.activeOrdinals.size === 0) return {};
				const { template } = buildLayout(state.doc, s.activeOrdinals, enabled);
				const attrs: Record<string, string> = { class: 'tomboy-hr-split-active' };
				if (template) attrs.style = `grid-template-columns:${template};`;
				return attrs;
			},
			handleClick(view, pos, event) {
				if (options.enabled && !options.enabled()) return false;
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
		},
		view(view: EditorView) {
			// Re-parent top-level content blocks into per-column flex
			// wrappers AFTER each PM render, and tear them down BEFORE the
			// next PM render. PM's DocViewDesc assumes node-desc DOMs are
			// direct children of view.dom — if it ever calls insertBefore /
			// removeChild on a node that's currently inside our wrapper,
			// it throws DOMException. Monkey-patching `updateStateInner` is
			// the only hook that runs synchronously BEFORE PM's DOM diff
			// phase; both `view.update(props)` (TipTap reconfigure) and
			// `view.updateState(state)` (transactions) flow through it.
			// The plugin's update() callback below runs AFTER.
			type PrivateView = {
				updateStateInner: (state: EditorState, prevProps: unknown) => void;
				domObserver?: { stop: () => void; start: () => void };
			};
			const privateView = view as unknown as PrivateView;
			const origUpdateStateInner = privateView.updateStateInner.bind(view);
			const patched = (state: EditorState, prevProps: unknown) => {
				// Pause the DOM mutation observer while we tear our
				// wrappers down — otherwise PM's DOMObserver may try to
				// re-parse the resulting `childList` mutations as user
				// input. PM versions without `domObserver` simply skip
				// the pause (graceful fallback).
				const obs = privateView.domObserver;
				obs?.stop();
				try {
					unwrapColumns(view.dom);
				} finally {
					obs?.start();
				}
				origUpdateStateInner(state, prevProps);
			};
			privateView.updateStateInner = patched;

			const applyWrap = () => {
				const enabled = options.enabled?.() ?? true;
				const s = hrSplitPluginKey.getState(view.state);
				if (!s || !enabled || s.activeOrdinals.size === 0) return;
				const { groups } = buildLayout(view.state.doc, s.activeOrdinals, enabled);
				const obs = privateView.domObserver;
				obs?.stop();
				try {
					wrapColumns(view.dom, groups);
				} finally {
					obs?.start();
				}
			};

			// Initial render — PM has already rendered the DOM by the time
			// view() is invoked, but no plugin update() has fired yet.
			applyWrap();

			return {
				update(_view: EditorView, _prevState: EditorState) {
					// PM has just re-rendered view.dom (the patched
					// updateStateInner above unwrapped before the diff).
					// Re-wrap to match the new doc + active set.
					applyWrap();
				},
				destroy() {
					const obs = privateView.domObserver;
					obs?.stop();
					try {
						unwrapColumns(view.dom);
					} finally {
						obs?.start();
					}
					privateView.updateStateInner = origUpdateStateInner;
				}
			};
		}
	});
}

export function getActiveOrdinals(state: EditorState): ReadonlySet<number> {
	const s = hrSplitPluginKey.getState(state);
	return s?.activeOrdinals ?? new Set();
}
