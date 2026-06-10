import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseMusicNote } from '$lib/music/parseMusicNote.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';
import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
import { pushToast } from '$lib/stores/toast.js';
import {
	deleteTrackRange,
	moveTrackSwap,
	canMoveTrack,
	buildTrackCopyHtml,
	trackCopyPlain
} from './trackTools.js';

export const musicNotePluginKey = new PluginKey('tomboyMusicNote');

export interface BuildOpts {
	currentUrl: string | null;
	isPlaying: boolean;
	/** 트랙 재생 — index 는 flatQueue 기준. (헤더 ▶ 는 그 플레이리스트 첫 트랙 index 로 호출.) */
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

/** pointerdown+mousedown+click 을 모두 삼켜 탭이 contenteditable 로 새지 않게 한다.
 *  (mousedown 만으론 모바일에서 캐럿/키보드를 못 막는다 — pointerdown 까지 필요.) */
function swallowGesture(el: HTMLElement, onClick: () => void): void {
	const swallow = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
	};
	el.addEventListener('pointerdown', swallow);
	el.addEventListener('mousedown', swallow);
	el.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick();
		// 제스처 안에서 동기 재생 — 모바일 자동재생 차단 회피.
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	});
}

/**
 * Pure logic for what tapping a track row should do.
 * - 현재 곡이면 재생/일시정지 토글.
 * - 아니면 onPlay(index) 로 그 곡 재생.
 * Extracted so it can be unit-tested without touching DOM or PM internals.
 */
export function handleTrackButtonClick(opts: BuildOpts, index: number, isCurrent: boolean): void {
	if (isCurrent) {
		musicPlayer.toggle();
	} else {
		opts.onPlay(index);
	}
}

/**
 * 플레이리스트 모드 트랙 행 전체를 덮는 "재생 버튼" 위젯 — 글머리표 자리에 마커 + 곡 제목.
 * 행 어디를 탭해도 재생되도록 행 폭을 채운다(CSS). 마커: 현재 트랙이면 이퀄라이저, 아니면 ♪.
 * 실제 URL/원문 텍스트는 music-row-hide 데코로 숨고, 이 위젯이 display 를 보여준다.
 * 체크 모드에선 li 가 contenteditable=false 라 빈 영역을 탭해도 캐럿이 잡히지 않는다.
 */
function trackRowButton(
	opts: BuildOpts,
	display: string,
	index: number,
	isCurrent: boolean,
	isPlaying: boolean
): HTMLElement {
	const span = document.createElement('span');
	span.className = 'music-track-name';
	span.contentEditable = 'false';
	span.setAttribute('role', 'button');
	span.setAttribute('tabindex', '0');
	span.setAttribute('aria-label', `${display} 재생`);
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
	swallowGesture(span, () => handleTrackButtonClick(opts, index, isCurrent));
	return span;
}

/** 플레이리스트 헤더 우측 ▶ — 그 플레이리스트를 첫 곡부터 재생. */
function playlistPlayButton(opts: BuildOpts, startIndex: number): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'music-pl-play-btn';
	btn.contentEditable = 'false';
	btn.setAttribute('data-no-drag', '');
	btn.setAttribute('aria-label', '플레이리스트 재생');
	btn.textContent = '▶';
	swallowGesture(btn, () => opts.onPlay(startIndex));
	return btn;
}

/** 제스처를 삼키되(탭이 contenteditable 로 새지 않게) 오디오는 건드리지 않는 버전.
 *  편집 도구(이동/복사/삭제)는 재생을 시작/이어가면 안 되므로 resume 호출이 없다. */
function swallowAction(el: HTMLElement, onClick: () => void): void {
	const swallow = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
	};
	el.addEventListener('pointerdown', swallow);
	el.addEventListener('mousedown', swallow);
	el.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick();
	});
}

/** 곡을 클립보드에 — 리치(제목+URL 보존) + 일반텍스트(URL) 폴백. */
async function copyTrack(track: MusicTrack): Promise<void> {
	const html = buildTrackCopyHtml(track);
	const plain = trackCopyPlain(track);
	try {
		await navigator.clipboard.write([
			new ClipboardItem({
				'text/html': new Blob([html], { type: 'text/html' }),
				'text/plain': new Blob([plain], { type: 'text/plain' })
			})
		]);
		pushToast('곡을 복사했어요', { timeoutMs: 1500 });
	} catch {
		try {
			await navigator.clipboard.writeText(plain);
			pushToast('곡 URL을 복사했어요', { timeoutMs: 1500 });
		} catch {
			pushToast('복사 실패', { kind: 'error' });
		}
	}
}

function toolButton(label: string, glyph: string, disabled: boolean, onClick: () => void): HTMLElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'music-track-tool';
	btn.contentEditable = 'false';
	btn.setAttribute('data-no-drag', '');
	btn.setAttribute('aria-label', label);
	btn.setAttribute('title', label);
	btn.textContent = glyph;
	if (disabled) btn.disabled = true;
	else swallowAction(btn, onClick);
	return btn;
}

/**
 * 곡 행 우측 편집 도구(▲▼ 순서이동 · ⧉ 복사 · 🗑 삭제). 기본 숨김이고
 * Ctrl(Mac ⌘) 누르는 동안만 노출(.music-ctrl-held). 클릭 시 *라이브* doc 에서
 * 범위를 다시 계산해 적용한다(데코 빌드 이후 doc 이 바뀌어도 안전). view 는
 * 클릭 클로저 안에서만 쓰므로(빌드 시 비참조) 테스트의 toDOM() 호출에도 안전.
 */
function trackToolsWidget(
	view: EditorView,
	liPos: number,
	track: MusicTrack,
	canUp: boolean,
	canDown: boolean
): HTMLElement {
	const wrap = document.createElement('span');
	wrap.className = 'music-track-tools';
	wrap.contentEditable = 'false';
	wrap.setAttribute('aria-hidden', 'true');
	wrap.appendChild(
		toolButton('위로 이동', '▲', !canUp, () => {
			const r = moveTrackSwap(view.state.doc, liPos, 'up');
			if (r) view.dispatch(view.state.tr.replaceWith(r.from, r.to, r.nodes));
		})
	);
	wrap.appendChild(
		toolButton('아래로 이동', '▼', !canDown, () => {
			const r = moveTrackSwap(view.state.doc, liPos, 'down');
			if (r) view.dispatch(view.state.tr.replaceWith(r.from, r.to, r.nodes));
		})
	);
	wrap.appendChild(toolButton('복사', '⧉', false, () => void copyTrack(track)));
	wrap.appendChild(
		toolButton('삭제', '🗑', false, () => {
			const r = deleteTrackRange(view.state.doc, liPos);
			if (r) view.dispatch(view.state.tr.delete(r.from, r.to));
		})
	);
	return wrap;
}

export function buildMusicDecorations(doc: PMNode, opts: BuildOpts): DecorationSet {
	const parsed = parseMusicNote(doc);
	if (!parsed.isMusic) return DecorationSet.empty;
	const decos: Decoration[] = [];

	// flatQueue 인덱스를 플레이리스트 순서대로 따라가며 데코를 만든다.
	let flatIndex = 0;
	for (const pl of parsed.playlists) {
		const firstIndex = flatIndex;

		// 헤더 우측 ▶(전체 재생) — 곡이 하나라도 있을 때만.
		if (pl.tracks.length > 0 && pl.headerPos >= 0) {
			const header = doc.nodeAt(pl.headerPos);
			if (header && header.isTextblock) {
				// 헤더 문단을 relative 로 만들어 우측 절대배치 버튼의 기준을 잡는다.
				decos.push(
					Decoration.node(pl.headerPos, pl.headerPos + header.nodeSize, { class: 'music-pl-header' })
				);
				// 문단 끝 인라인 위치에 위젯(절대배치라 시각 위치는 CSS 가 결정).
				const anchor = pl.headerPos + header.nodeSize - 1;
				decos.push(
					Decoration.widget(anchor, () => playlistPlayButton(opts, firstIndex), {
						side: 1,
						key: `music-pl-play:${pl.headerPos}:${firstIndex}`,
						ignoreSelection: true
					})
				);
			}
		}

		for (const track of pl.tracks) {
			const index = flatIndex++;
			const li = doc.nodeAt(track.liPos);
			if (!li || li.type.name !== 'listItem') continue;
			const liEnd = track.liPos + li.nodeSize;
			const isCurrent = opts.currentUrl !== null && track.url === opts.currentUrl;

			// 행: 글머리표 제거 + 현재곡 강조 + 비편집(contenteditable=false). 체크 모드에선
			// 곡 행에 커서가 갈 수 없고 탭하면 재생된다 — 편집은 체크박스를 끄면(텍스트 모드,
			// 데코 자체가 사라짐) 가능. 빈 영역 탭도 캐럿이 안 잡히게 li 전체를 비편집으로.
			const rowClasses = ['music-track', 'music-track--play'];
			if (isCurrent) rowClasses.push('music-track--playing');
			decos.push(
				Decoration.node(track.liPos, liEnd, {
					class: rowClasses.join(' '),
					contenteditable: 'false'
				})
			);

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
					decos.push(
						Decoration.node(childPos, childPos + child.nodeSize, { class: 'music-row-hide' })
					);
				}
				childPos += child.nodeSize;
			});

			// 인라인 위젯 앵커. liPos+1 은 <li>/<p> 경계라 위젯이 별도 줄로 렌더돼 빈 줄이
			// 생긴다. 첫 문단(textblock) 안쪽(liPos+2)에 두어 글머리표 자리에 붙게 한다.
			const inlinePos = li.firstChild?.isTextblock ? track.liPos + 2 : track.liPos + 1;
			decos.push(
				Decoration.widget(
					inlinePos,
					() => trackRowButton(opts, track.display, index, isCurrent, opts.isPlaying),
					{
						side: -1,
						key: `music-name:${track.url}:${isCurrent}:${opts.isPlaying}`,
						ignoreSelection: true
					}
				)
			);

			// Ctrl 편집 도구(우측, 기본 숨김). 경계 판정은 빌드 시 doc 으로 미리 계산해
			// key 에 넣는다 → 순서가 바뀌면 비활성화 상태도 갱신(DOM 재사용 방지).
			const liPos = track.liPos;
			const canUp = canMoveTrack(doc, liPos, 'up');
			const canDown = canMoveTrack(doc, liPos, 'down');
			decos.push(
				Decoration.widget(
					inlinePos,
					(view) => trackToolsWidget(view, liPos, track, canUp, canDown),
					{
						side: 1,
						key: `music-tools:${track.url}:${index}:${canUp}:${canDown}`,
						ignoreSelection: true
					}
				)
			);
		}
	}

	return DecorationSet.create(doc, decos);
}

export function createMusicNotePlugin(getGuid: () => string = () => ''): Plugin {
	return new Plugin({
		key: musicNotePluginKey,
		// Ctrl(Mac ⌘)을 누르는 동안 곡별 편집 도구를 노출. 글로벌 keydown/keyup 으로
		// 수정자 상태를 읽어 view.dom 에 .music-ctrl-held 토글(CSS 가 표시 제어).
		// blur 시 해제 — 누른 채 창을 떠나 keyup 을 놓쳐도 고착되지 않게.
		view(editorView) {
			const dom = editorView.dom as HTMLElement;
			const sync = (e: KeyboardEvent) => {
				dom.classList.toggle('music-ctrl-held', e.ctrlKey || e.metaKey);
			};
			const clear = () => dom.classList.remove('music-ctrl-held');
			window.addEventListener('keydown', sync, true);
			window.addEventListener('keyup', sync, true);
			window.addEventListener('blur', clear);
			return {
				destroy() {
					window.removeEventListener('keydown', sync, true);
					window.removeEventListener('keyup', sync, true);
					window.removeEventListener('blur', clear);
					dom.classList.remove('music-ctrl-held');
				}
			};
		},
		props: {
			decorations(state) {
				const parsed = parseMusicNote(state.doc);
				if (!parsed.isMusic) return null;
				return buildMusicDecorations(state.doc, {
					currentUrl: musicPlayer.currentTrack?.url ?? null,
					isPlaying: musicPlayer.isPlaying,
					// 트랙/플레이리스트 재생 = 이 노트를 활성 큐로 만들고 재생. 노트를 여는 것만으론
					// 큐가 바뀌지 않으므로(글로벌 now-playing 보존) 여기서 명시적으로 setQueue.
					onPlay: (index) => {
						musicPlayer.setQueue(getGuid(), parsed.flatQueue, parsed.name);
						musicPlayer.play(index);
					}
				});
			}
		}
	});
}
