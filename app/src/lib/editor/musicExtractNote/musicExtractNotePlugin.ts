import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isExtractTitle } from '$lib/musicExtract/parseExtractNote.js';
import { runExtractButtonClick } from './runExtractButtonClick.js';

export const musicExtractNotePluginKey = new PluginKey<DecorationSet>('tomboyMusicExtractNote');

function renderButton(view: EditorView): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tomboy-music-extract-run';
	btn.contentEditable = 'false';
	btn.textContent = '⟳ 진행';
	btn.addEventListener('click', async (e) => {
		e.preventDefault();
		if (btn.disabled) return;
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = '⟳ 진행 중…';
		try {
			await runExtractButtonClick(view);
		} finally {
			btn.disabled = false;
			btn.textContent = orig;
		}
	});
	return btn;
}

function buildDecorations(doc: PMNode): DecorationSet {
	const first = doc.firstChild;
	if (!first || !isExtractTitle(first.textContent)) return DecorationSet.empty;
	// Boundary AFTER the title (not inside it) — the title is display:none'd by
	// titleIsolation; a widget inside it would vanish too. See automationNotePlugin.
	const afterTitlePos = first.nodeSize;
	const widget = Decoration.widget(afterTitlePos, (view) => renderButton(view), { side: 1, key: 'music-extract-run' });
	return DecorationSet.create(doc, [widget]);
}

export function createMusicExtractNotePlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: musicExtractNotePluginKey,
		state: {
			init(_, { doc }): DecorationSet {
				return buildDecorations(doc);
			},
			apply(tr, old): DecorationSet {
				return tr.docChanged ? buildDecorations(tr.doc) : old.map(tr.mapping, tr.doc);
			}
		},
		props: {
			decorations(state): DecorationSet | undefined {
				return musicExtractNotePluginKey.getState(state);
			}
		}
	});
}
