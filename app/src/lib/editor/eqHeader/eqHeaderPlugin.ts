import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

/** Shared plugin key so the host (TomboyEditor) can seed initial state. */
export const eqHeaderPluginKey = new PluginKey<EqHeaderState>('tomboyEqHeader');

/**
 * A top-level child is an `===` marker if it's a paragraph whose entire
 * trimmed text is 3+ '=' characters. Mirrors `isDashParagraph` in the
 * hrSplit plugin (`-{3,}`).
 */
export function isEqualsParagraph(node: PMNode): boolean {
	if (node.type.name !== 'paragraph') return false;
	return /^={3,}$/.test(node.textContent.trim());
}

/**
 * Top-level index (>= 1) of the FIRST `===` marker, or null. Index 0 is the
 * title line and is never a boundary — the sticky header must contain at
 * least the title. When multiple `===` exist, the topmost wins; the rest
 * render as plain bold lines (see buildDecos).
 */
export function findEqBoundary(doc: PMNode): number | null {
	let result: number | null = null;
	doc.forEach((node, _offset, idx) => {
		if (result !== null) return;
		if (idx >= 1 && isEqualsParagraph(node)) result = idx;
	});
	return result;
}

export interface EqHeaderState {
	/** Top-level index of the active boundary marker, or null. */
	boundary: number | null;
	/** Bumped on every doc change so the host knows when to re-clone. */
	version: number;
	decos: DecorationSet;
}

/** Every `===` (index >= 1) gets `.tomboy-eq-marker`; the boundary also gets
 *  `.tomboy-eq-marker-active`. Index 0 is the title — never decorated. */
function buildDecos(doc: PMNode, boundary: number | null): DecorationSet {
	const decos: Decoration[] = [];
	doc.forEach((node, offset, idx) => {
		if (idx < 1 || !isEqualsParagraph(node)) return;
		const cls =
			idx === boundary
				? 'tomboy-eq-marker tomboy-eq-marker-active'
				: 'tomboy-eq-marker';
		decos.push(Decoration.node(offset, offset + node.nodeSize, { class: cls }));
	});
	return DecorationSet.create(doc, decos);
}

export interface EqHeaderOptions {
	/** Fired after editor view init and whenever the boundary or doc version
	 *  changes. The host re-seeds its reactive state from this. */
	onChange?: (boundary: number | null, version: number) => void;
}

export function createEqHeaderPlugin(options: EqHeaderOptions = {}): Plugin<EqHeaderState> {
	return new Plugin<EqHeaderState>({
		key: eqHeaderPluginKey,
		state: {
			init(_config, state: EditorState) {
				const boundary = findEqBoundary(state.doc);
				return { boundary, version: 0, decos: buildDecos(state.doc, boundary) };
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				const boundary = findEqBoundary(newState.doc);
				return {
					boundary,
					version: prev.version + 1,
					decos: buildDecos(newState.doc, boundary)
				};
			}
		},
		props: {
			decorations(state) {
				return eqHeaderPluginKey.getState(state)?.decos ?? null;
			}
		},
		view(view) {
			// onChange is deferred via queueMicrotask (same as hrSplit/hrFold):
			// it runs inside the PM dispatch cycle, and the host callback mutates
			// external reactive state — deferring keeps any reaction that might
			// dispatch a transaction out of the current (re-entrant-illegal) cycle.
			// Emit once on mount so a note that already contains `===` shows the
			// sticky header without waiting for an edit.
			const init = eqHeaderPluginKey.getState(view.state);
			if (init) queueMicrotask(() => options.onChange?.(init.boundary, init.version));
			return {
				update(v, prevState) {
					const cur = eqHeaderPluginKey.getState(v.state);
					const old = eqHeaderPluginKey.getState(prevState);
					if (!cur) return;
					if (!old || cur.version !== old.version || cur.boundary !== old.boundary) {
						queueMicrotask(() => options.onChange?.(cur.boundary, cur.version));
					}
				}
			};
		}
	});
}
