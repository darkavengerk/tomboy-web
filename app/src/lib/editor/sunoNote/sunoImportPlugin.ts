import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseSunoLines } from '$lib/music/parseSunoLine.js';
import { runSunoImportClick } from './runSunoImportClick.js';

export const sunoImportPluginKey = new PluginKey<DecorationSet>('tomboySunoImport');

function renderButton(view: EditorView, sunoUrl: string): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tomboy-suno-import';
	btn.contentEditable = 'false';
	btn.textContent = '가져오기';
	// pointerdown/mousedown 을 삼켜 모바일에서 탭이 contenteditable 로 새어 캐럿/키보드가 뜨는 걸 막는다.
	const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
	btn.addEventListener('pointerdown', swallow);
	btn.addEventListener('mousedown', swallow);
	btn.addEventListener('click', async (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (btn.disabled) return;
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = '가져오는 중…';
		try {
			await runSunoImportClick(view, sunoUrl);
		} finally {
			btn.disabled = false;
			btn.textContent = orig;
		}
	});
	return btn;
}

function buildDecorations(doc: PMNode): DecorationSet {
	const lines = parseSunoLines(doc).filter((l) => !l.alreadyImported);
	if (lines.length === 0) return DecorationSet.empty;
	const decos = lines.map((l) => {
		const node = doc.nodeAt(l.paraPos);
		const end = l.paraPos + (node?.nodeSize ?? 2) - 1; // 단락 textblock 내부 끝
		return Decoration.widget(end, (view) => renderButton(view, l.url), { side: 1, key: `suno-import:${l.url}` });
	});
	return DecorationSet.create(doc, decos);
}

export function createSunoImportPlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: sunoImportPluginKey,
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
				return sunoImportPluginKey.getState(state);
			}
		}
	});
}
