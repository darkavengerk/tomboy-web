import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';
import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { modKeys } from '$lib/desktop/modKeys.svelte.js';

export const musicNotePluginKey = new PluginKey('tomboyMusicNote');

export interface BuildOpts {
	currentUrl: string | null;
	isPlaying: boolean;
	ctrlActive: boolean;
	onPlay: (index: number) => void;
}

function eqWidget(playing: boolean): HTMLElement {
	const span = document.createElement('span');
	span.className = playing ? 'music-track-eq' : 'music-track-eq music-track-eq--paused';
	span.contentEditable = 'false';
	span.setAttribute('aria-hidden', 'true');
	span.innerHTML = '<i></i><i></i><i></i>';
	return span;
}

/**
 * Pure logic for what clicking a track play button should do.
 * Extracted so it can be unit-tested without touching DOM or PM internals.
 * - If the track is already current (isCurrent), toggle playback.
 * - Otherwise, invoke onPlay(index).
 */
export function handleTrackButtonClick(opts: BuildOpts, index: number, isCurrent: boolean): void {
	if (isCurrent) {
		musicPlayer.toggle();
	} else {
		opts.onPlay(index);
	}
}

export function buildMusicDecorations(doc: PMNode, opts: BuildOpts): DecorationSet {
	const { flatQueue } = parseMusicNote(doc);
	if (flatQueue.length === 0) return DecorationSet.empty;
	const decos: Decoration[] = [];

	flatQueue.forEach((track, index) => {
		const li = doc.nodeAt(track.liPos);
		if (!li || li.type.name !== 'listItem') return;
		const isCurrent = opts.currentUrl !== null && track.url === opts.currentUrl;

		// 인라인 위젯 앵커. liPos+1 은 <li>/<p> 블록 경계라 위젯이 제목 위 별도 줄에
		// 렌더되어 빈 줄이 생긴다. 첫 문단(textblock) 안쪽(liPos+2)에 두어 글머리표
		// 자리에 인라인으로 붙게 한다.
		const inlinePos = li.firstChild?.isTextblock ? track.liPos + 2 : track.liPos + 1;

		if (isCurrent) {
			decos.push(
				Decoration.node(track.liPos, track.liPos + li.nodeSize, { class: 'music-track--playing' })
			);
			decos.push(
				Decoration.widget(inlinePos, () => eqWidget(opts.isPlaying), {
					side: -1,
					key: `music-eq:${track.url}:${opts.isPlaying}`,
					ignoreSelection: true
				})
			);
		}

		if (opts.ctrlActive) {
			const playingNow = isCurrent && opts.isPlaying;
			decos.push(
				Decoration.widget(
					inlinePos,
					() => {
						const btn = document.createElement('button');
						btn.type = 'button';
						btn.className = 'tomboy-music-play-btn';
						btn.contentEditable = 'false';
						btn.setAttribute('data-no-drag', '');
						btn.textContent = playingNow ? '⏸' : '▶';
						btn.addEventListener('mousedown', (e) => {
							e.preventDefault();
							e.stopPropagation();
						});
						btn.addEventListener('click', (e) => {
							e.preventDefault();
							e.stopPropagation();
							handleTrackButtonClick(opts, index, isCurrent);
						});
						return btn;
					},
					{ side: -1, key: `music-play:${index}:${playingNow}`, ignoreSelection: true }
				)
			);
		}
	});

	return DecorationSet.create(doc, decos);
}

export function createMusicNotePlugin(): Plugin {
	return new Plugin({
		key: musicNotePluginKey,
		props: {
			decorations(state) {
				const { isMusic } = parseMusicNote(state.doc);
				if (!isMusic) return null;
				return buildMusicDecorations(state.doc, {
					currentUrl: musicPlayer.currentTrack?.url ?? null,
					isPlaying: musicPlayer.isPlaying,
					ctrlActive: modKeys.ctrl,
					onPlay: (index) => musicPlayer.play(index)
				});
			}
		}
	});
}
