import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

export interface SavedSelection {
	from: number;
	to: number;
}

/**
 * Build a transaction that restores `saved` selection onto `state`'s (already
 * swapped) document, clamped to the doc size and snapped to valid positions via
 * TextSelection.between's bias so it never lands inside an atom node
 * (inlineCheckbox / footnote / radio). Returns null if no sensible selection can
 * be made (caller then leaves the default caret). Never throws.
 */
export function restoreSelectionClamped(
	state: EditorState,
	saved: SavedSelection
): Transaction | null {
	try {
		const size = state.doc.content.size;
		const from = Math.max(0, Math.min(saved.from, size));
		const to = Math.max(from, Math.min(saved.to, size));
		const sel = TextSelection.between(state.doc.resolve(from), state.doc.resolve(to), 1);
		return state.tr.setSelection(sel).setMeta('addToHistory', false);
	} catch {
		return null;
	}
}
