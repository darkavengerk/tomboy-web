import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findMatches, type FindMatch } from './findMatches.js';

/** Plugin state — the live search and its resolved matches. */
export interface FindState {
	query: string;
	matches: FindMatch[];
	/** Index into `matches` of the highlighted match, or -1 when none. */
	activeIndex: number;
}

/** Meta payloads accepted on `findPluginKey` via `tr.setMeta`. */
export type FindMeta =
	| { query: string }
	| { nav: 'next' | 'prev' }
	| { close: true };

export const findPluginKey = new PluginKey<FindState>('tomboyFind');

/** Wrap `index` into `[0, length)`, returning -1 for an empty range. */
function wrapIndex(index: number, length: number): number {
	if (length === 0) return -1;
	return ((index % length) + length) % length;
}

/** Compute the next plugin state for an explicit meta command. */
function reduceMeta(prev: FindState, meta: FindMeta, doc: PMNode): FindState {
	if ('close' in meta) {
		return { query: '', matches: [], activeIndex: -1 };
	}
	if ('query' in meta) {
		const matches = findMatches(doc, meta.query);
		return {
			query: meta.query,
			matches,
			activeIndex: matches.length > 0 ? 0 : -1
		};
	}
	// { nav } — no-op when there is nothing to navigate.
	if (prev.matches.length === 0) return prev;
	const delta = meta.nav === 'next' ? 1 : -1;
	return {
		...prev,
		activeIndex: wrapIndex(prev.activeIndex + delta, prev.matches.length)
	};
}

/** Build the green-highlight decoration set for the current matches. */
function buildDecorations(state: FindState, doc: PMNode): DecorationSet {
	if (state.matches.length === 0) return DecorationSet.empty;
	const decos = state.matches.map((m, i) =>
		Decoration.inline(m.from, m.to, {
			class:
				i === state.activeIndex
					? 'tomboy-find-match tomboy-find-active'
					: 'tomboy-find-match'
		})
	);
	return DecorationSet.create(doc, decos);
}

/**
 * ProseMirror plugin for in-note find. Holds the active search, resolves
 * matches to document positions, and renders them as inline decorations.
 *
 * Invariant: the document is NEVER modified — matches are decorations
 * only, so a search triggers no save and never pollutes the `.note` XML.
 */
export function createFindPlugin(): Plugin<FindState> {
	return new Plugin<FindState>({
		key: findPluginKey,
		state: {
			init: () => ({ query: '', matches: [], activeIndex: -1 }),
			apply(
				tr: Transaction,
				prev: FindState,
				_old: EditorState,
				next: EditorState
			): FindState {
				const meta = tr.getMeta(findPluginKey) as FindMeta | undefined;
				if (meta) return reduceMeta(prev, meta, next.doc);
				// No meta: if the doc changed under an active search,
				// re-scan against the new doc and clamp the active index.
				if (tr.docChanged && prev.query !== '') {
					const matches = findMatches(next.doc, prev.query);
					const activeIndex =
						matches.length === 0
							? -1
							: Math.min(Math.max(prev.activeIndex, 0), matches.length - 1);
					return { query: prev.query, matches, activeIndex };
				}
				return prev;
			}
		},
		props: {
			decorations(state) {
				const fs = findPluginKey.getState(state);
				return fs ? buildDecorations(fs, state.doc) : DecorationSet.empty;
			}
		},
		view() {
			let prevActive = -1;
			let prevMatches: FindMatch[] | null = null;
			return {
				update(view: EditorView) {
					const fs = findPluginKey.getState(view.state);
					if (!fs) return;
					const changed =
						fs.activeIndex !== prevActive || fs.matches !== prevMatches;
					prevActive = fs.activeIndex;
					prevMatches = fs.matches;
					if (!changed || fs.activeIndex < 0) return;
					// Scroll the active match into view once the decoration
					// DOM has been applied.
					requestAnimationFrame(() => {
						const el = view.dom.querySelector('.tomboy-find-active');
						if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
							(el as HTMLElement).scrollIntoView({ block: 'center' });
						}
					});
				}
			};
		}
	});
}
