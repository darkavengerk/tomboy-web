import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';
import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
import { modKeys } from '$lib/desktop/modKeys.svelte.js';

export const musicNotePluginKey = new PluginKey('tomboyMusicNote');

export interface BuildOpts {
	currentUrl: string | null;
	isPlaying: boolean;
	ctrlActive: boolean;
	onPlay: (index: number) => void;
	/** 현재 선택(커서) 범위 — 트랙 li 안이면 그 트랙은 원문 노출(편집용). */
	selFrom?: number;
	selTo?: number;
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
 * 플레이리스트 모드 트랙의 "제목만" 표시 위젯 — 글머리표 자리에 마커 + 곡 제목.
 * 마커: 현재 트랙이면 이퀄라이저(재생/일시정지), 아니면 ♪.
 * 실제 URL/원문 텍스트는 music-row-hide 데코로 숨겨지고, 이 위젯이 display 를 보여준다.
 */
function trackNameWidget(display: string, isCurrent: boolean, isPlaying: boolean): HTMLElement {
	const span = document.createElement('span');
	span.className = 'music-track-name';
	span.contentEditable = 'false';
	const mark = document.createElement('span');
	mark.className = 'music-track-mark';
	if (isCurrent) {
		mark.appendChild(eqWidget(isPlaying));
	} else {
		mark.textContent = '♪';
	}
	span.appendChild(mark);
	const label = document.createElement('span');
	label.className = 'music-track-label';
	label.textContent = display;
	span.appendChild(label);
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
	const { flatQueue, isMusic } = parseMusicNote(doc);
	if (!isMusic) return DecorationSet.empty;
	const decos: Decoration[] = [];

	// 제목(첫 블록) 아래에 떠 있는 컨트롤 패널 자리 확보. 패널이 자기 높이를
	// --music-reserve 로 알려주면 margin-bottom 으로 비운다(트랙 유무와 무관 —
	// 빈 음악 노트에도 패널은 항상 뜬다).
	const title = doc.firstChild;
	if (title) decos.push(Decoration.node(0, title.nodeSize, { class: 'music-title-block' }));

	flatQueue.forEach((track, index) => {
		const li = doc.nodeAt(track.liPos);
		if (!li || li.type.name !== 'listItem') return;
		const liEnd = track.liPos + li.nodeSize;
		const isCurrent = opts.currentUrl !== null && track.url === opts.currentUrl;

		// 커서/선택이 이 트랙 li 안이면 "편집 중" — 원문(URL)을 그대로 노출하고
		// 제목 위젯/숨김 데코를 생략해 자유롭게 고칠 수 있게 한다. PM 은 selection
		// 변경마다 decorations 를 재계산하므로 진입/이탈 시 자동 토글된다.
		const editing =
			opts.selFrom != null && opts.selTo != null && opts.selTo > track.liPos && opts.selFrom < liEnd;

		// 행 스타일(글머리표 제거 + 현재곡 강조)은 편집 중에도 유지.
		// ctrl 일 때만 우측에 ▶ 버튼이 떠 텍스트가 underlap 안 되게 패딩 확보.
		const rowClasses = ['music-track'];
		if (isCurrent) rowClasses.push('music-track--playing');
		if (opts.ctrlActive) rowClasses.push('music-track--ctrl');
		decos.push(Decoration.node(track.liPos, liEnd, { class: rowClasses.join(' ') }));

		// 인라인 위젯 앵커. liPos+1 은 <li>/<p> 블록 경계라 위젯이 제목 위 별도 줄에
		// 렌더되어 빈 줄이 생긴다. 첫 문단(textblock) 안쪽(liPos+2)에 두어 글머리표
		// 자리에 인라인으로 붙게 한다.
		const inlinePos = li.firstChild?.isTextblock ? track.liPos + 2 : track.liPos + 1;

		if (!editing) {
			// 원문 숨김: 첫 문단의 인라인 텍스트(URL 또는 제목) + 중첩 리스트(URL 서브아이템).
			const first = li.firstChild;
			if (first?.isTextblock && first.content.size > 0) {
				const from = track.liPos + 2;
				decos.push(Decoration.inline(from, from + first.content.size, { class: 'music-row-hide' }));
			}
			let childPos = track.liPos + 1;
			li.forEach((child) => {
				const name = child.type.name;
				if (name === 'bulletList' || name === 'orderedList') {
					decos.push(Decoration.node(childPos, childPos + child.nodeSize, { class: 'music-row-hide' }));
				}
				childPos += child.nodeSize;
			});

			// 제목 위젯(마커 + display).
			decos.push(
				Decoration.widget(inlinePos, () => trackNameWidget(track.display, isCurrent, opts.isPlaying), {
					side: -1,
					key: `music-name:${track.url}:${isCurrent}:${opts.isPlaying}`,
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
						// pointerdown 까지 막아야 터치에서 탭이 contenteditable 로
						// 새어 캐럿이 잡히고 키보드가 뜨는 걸 막는다(mousedown 만으론
						// 모바일에서 포커스를 못 막음).
						const swallow = (e: Event) => {
							e.preventDefault();
							e.stopPropagation();
						};
						btn.addEventListener('pointerdown', swallow);
						btn.addEventListener('mousedown', swallow);
						btn.addEventListener('click', (e) => {
							e.preventDefault();
							e.stopPropagation();
							handleTrackButtonClick(opts, index, isCurrent);
							// 제스처 안에서 동기 재생 — 모바일 자동재생 차단 회피.
							if (musicPlayer.isPlaying) resumePlaybackFromGesture();
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

export function createMusicNotePlugin(getGuid: () => string = () => ''): Plugin {
	return new Plugin({
		key: musicNotePluginKey,
		props: {
			decorations(state) {
				const parsed = parseMusicNote(state.doc);
				if (!parsed.isMusic) return null;
				return buildMusicDecorations(state.doc, {
					currentUrl: musicPlayer.currentTrack?.url ?? null,
					isPlaying: musicPlayer.isPlaying,
					ctrlActive: modKeys.ctrl,
					// 트랙 재생 = 이 노트를 활성 큐로 만들고 재생. 노트를 여는 것만으로는
					// 큐가 바뀌지 않으므로(글로벌 now-playing 보존) 여기서 명시적으로 setQueue.
					onPlay: (index) => {
						musicPlayer.setQueue(getGuid(), parsed.flatQueue, parsed.name);
						musicPlayer.play(index);
					},
					selFrom: state.selection.from,
					selTo: state.selection.to
				});
			}
		}
	});
}
