import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isExtractTitle } from '$lib/musicExtract/parseExtractNote.js';
import { donePlaylistAnchors } from '$lib/musicExtract/buildMusicNote.js';
import { runExtractButtonClick } from './runExtractButtonClick.js';
import { createMusicNoteFromPlaylist } from './createMusicNoteFromPlaylist.js';

export const musicExtractNotePluginKey = new PluginKey<DecorationSet>('tomboyMusicExtractNote');

export interface MusicExtractPluginOptions {
	/** 내부링크 이동 — 만든/연 음악 노트로 호스트가 네비게이트. */
	oninternallink?: (title: string) => void;
}

function renderRunButton(view: EditorView): HTMLElement {
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

function renderMakeNoteButton(
	view: EditorView,
	source: string,
	opts: MusicExtractPluginOptions
): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tomboy-music-extract-makenote';
	btn.contentEditable = 'false';
	btn.textContent = '🎵 노트 만들기';
	// contenteditable 안 위젯 — 탭/클릭이 캐럿을 심거나 키보드를 띄우지 않게 mousedown 억제.
	btn.addEventListener('mousedown', (e) => e.preventDefault());
	btn.addEventListener('click', async (e) => {
		e.preventDefault();
		if (btn.disabled) return;
		btn.disabled = true;
		try {
			await createMusicNoteFromPlaylist(view, source, opts.oninternallink);
		} finally {
			btn.disabled = false;
		}
	});
	return btn;
}

function buildDecorations(doc: PMNode, opts: MusicExtractPluginOptions): DecorationSet {
	const first = doc.firstChild;
	if (!first || !isExtractTitle(first.textContent)) return DecorationSet.empty;
	const decos: Decoration[] = [];
	// Boundary AFTER the title (not inside it) — the title is display:none'd by
	// titleIsolation; a widget inside it would vanish too. See automationNotePlugin.
	decos.push(
		Decoration.widget(first.nodeSize, (view) => renderRunButton(view), {
			side: 1,
			key: 'music-extract-run'
		})
	);
	// 완료 재생목록마다 헤더 끝에 '노트 만들기' 위젯. key 에 source 를 넣어 재생목록별로 고정·재사용.
	for (const a of donePlaylistAnchors(doc)) {
		decos.push(
			Decoration.widget(a.pos, (view) => renderMakeNoteButton(view, a.source, opts), {
				side: 1,
				key: `music-extract-makenote:${a.source}`
			})
		);
	}
	return DecorationSet.create(doc, decos);
}

export function createMusicExtractNotePlugin(
	opts: MusicExtractPluginOptions = {}
): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: musicExtractNotePluginKey,
		state: {
			init(_, { doc }): DecorationSet {
				return buildDecorations(doc, opts);
			},
			apply(tr, old): DecorationSet {
				return tr.docChanged ? buildDecorations(tr.doc, opts) : old.map(tr.mapping, tr.doc);
			}
		},
		props: {
			decorations(state): DecorationSet | undefined {
				return musicExtractNotePluginKey.getState(state);
			}
		}
	});
}
