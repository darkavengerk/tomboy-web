import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { MUSIC_CONTROL_MARKER } from '$lib/music/musicControlNote.js';

export const musicControlHidePluginKey = new PluginKey('musicControlHide');

/** {from,to} of the top-level marker block, or null. */
function findMarkerRange(doc: PMNode): { from: number; to: number } | null {
	let result: { from: number; to: number } | null = null;
	doc.forEach((node, offset) => {
		if (result) return;
		if (node.isTextblock && node.textContent.startsWith(MUSIC_CONTROL_MARKER)) {
			result = { from: offset, to: offset + node.nodeSize };
		}
	});
	return result;
}

export function createMusicControlHidePlugin(opts: { enabled: () => boolean }): Plugin {
	return new Plugin({
		key: musicControlHidePluginKey,
		props: {
			decorations(state) {
				if (!opts.enabled()) return DecorationSet.empty;
				const range = findMarkerRange(state.doc);
				if (!range) return DecorationSet.empty;
				return DecorationSet.create(state.doc, [
					Decoration.node(range.from, range.to, { class: 'tomboy-music-control-hidden' })
				]);
			}
		},
		// Keep the caret out of the hidden marker block.
		appendTransaction(_trs, _old, newState) {
			if (!opts.enabled()) return null;
			const range = findMarkerRange(newState.doc);
			if (!range) return null;
			const sel = newState.selection;
			const inside = (p: number) => p > range.from && p < range.to;
			if (inside(sel.anchor) || inside(sel.head)) {
				// range.from - 1 = end of the block before the marker. The control note always
				// has its title paragraph first, so the marker is never block 0 → this is always
				// a valid inline position; Math.max(0, …) is a defensive belt-and-suspenders.
				const target = Math.max(0, range.from - 1);
				return newState.tr.setSelection(TextSelection.create(newState.doc, target));
			}
			return null;
		}
	});
}
