<script lang="ts">
	import { untrack } from 'svelte';
	import type { Editor } from '@tiptap/core';
	import { parseMusicNote } from '$lib/music/parseMusicNote.js';
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';

	// 순수 뷰. 오디오 재생은 전역 엔진(musicAudio.svelte.ts, +layout 설치)이 단일
	// <audio> 로 담당한다. 이 컴포넌트는 musicPlayer(싱글톤)를 읽어 표시/조작만 한다.
	// 여러 패널이 떠 있어도 모두 같은 글로벌 상태를 본다.
	type Props = { editor: Editor; guid: string };
	let { editor, guid }: Props = $props();

	let version = $state(0);
	let refreshN = 0;

	const onUpdate = () => {
		version = (version + 1) | 0;
	};
	$effect(() => {
		editor.on('update', onUpdate);
		return () => {
			editor.off('update', onUpdate);
		};
	});

	// 이 노트의 파싱 결과(로컬). version 으로만 갱신.
	const parsedNote = $derived.by(() => {
		version;
		return parseMusicNote(editor.state.doc);
	});

	// 이 노트가 "활성(재생 중인) 노트"면 편집 시 글로벌 큐를 재동기화(인덱스 보존).
	// 활성 노트가 아니면 건드리지 않는다 → 노트를 여는 것만으로 재생이 바뀌지 않음.
	// untrack 으로 player 자기-구독 루프 차단. 의존성은 version(=doc 변경)뿐.
	$effect(() => {
		version;
		untrack(() => {
			if (musicPlayer.activeNoteGuid === guid) {
				const note = parseMusicNote(editor.state.doc);
				musicPlayer.setQueue(guid, note.flatQueue, note.name);
			}
		});
	});

	// 재생 상태 변화 → 에디터 데코 갱신(no-op tr). 에디터별로 필요(트랙 강조).
	$effect(() => {
		musicPlayer.currentIndex;
		musicPlayer.isPlaying;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(ed.state.tr.setMeta('musicRefresh', (refreshN = (refreshN + 1) | 0)));
	});

	// 표시 대상: 글로벌 현재 곡(재생/일시정지 중) 우선, 없으면 이 노트의 첫 곡 미리보기.
	const globalTrack = $derived(musicPlayer.currentTrack);
	const localFirst = $derived(parsedNote.flatQueue[0] ?? null);
	const isGlobalActive = $derived(globalTrack !== null);
	const shown = $derived(globalTrack ?? localFirst);
	const playing = $derived(musicPlayer.isPlaying);
	const label = $derived(shown?.playlistLabel ?? '');
	const statusText = $derived(isGlobalActive ? (playing ? '재생 중' : '일시정지') : '대기');

	const repeat = $derived(musicPlayer.repeat);
	const shuffle = $derived(musicPlayer.shuffle);
	const repeatLabel = $derived(
		repeat === 'one' ? '한 곡 반복' : repeat === 'all' ? '전체 반복' : '반복 없음'
	);

	function startLocal() {
		const note = parsedNote;
		if (note.flatQueue.length === 0) return;
		musicPlayer.setQueue(guid, note.flatQueue, note.name);
		musicPlayer.play(0);
	}
	function onMainBtn() {
		if (isGlobalActive) musicPlayer.toggle();
		else startLocal();
		// 모바일 재생 잠금 해제: 제스처(이 onclick) 안에서 동기로 play() 해야 한다.
		// 스토어만 갱신하고 $effect 에 맡기면 제스처 밖이라 iOS 가 차단한다.
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	// prev/next 도 같은 제스처 규칙 — 일시정지 상태에서 곡만 바꿔도 재생을 이어준다.
	function onPrev() {
		musicPlayer.prev();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function onNext() {
		musicPlayer.next();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}

	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
	function onSeekInput(e: Event) {
		musicPlayer.requestSeek(Number((e.currentTarget as HTMLInputElement).value));
	}
</script>

<div class="music-bar">
	<div class="music-now">
		{statusText}
		{#if label}<span class="music-pl">{label}</span>{/if}
		{#if shown}<b>{shown.display}</b>{:else}<span class="music-empty">재생할 곡이 없습니다</span>{/if}
	</div>
	<div class="music-row">
		<div class="music-btns">
			<button
				type="button"
				onclick={onPrev}
				disabled={!isGlobalActive}
				aria-label="이전">⏮</button
			>
			<button
				type="button"
				class="main"
				onclick={onMainBtn}
				disabled={!isGlobalActive && !shown}
				aria-label={isGlobalActive && playing ? '일시정지' : '재생'}
				>{isGlobalActive && playing ? '⏸' : '▶'}</button
			>
			<button
				type="button"
				onclick={onNext}
				disabled={!isGlobalActive}
				aria-label="다음">⏭</button
			>
		</div>
		<div class="music-modes">
			<button
				type="button"
				class="mode"
				class:active={repeat !== 'off'}
				onclick={() => musicPlayer.cycleRepeat()}
				aria-label={repeatLabel}
				title={repeatLabel}>{repeat === 'one' ? '🔂' : '🔁'}</button
			>
			<button
				type="button"
				class="mode"
				class:active={shuffle}
				onclick={() => musicPlayer.toggleShuffle()}
				aria-label="랜덤 섞기"
				aria-pressed={shuffle}
				title="랜덤 섞기">🔀</button
			>
		</div>
		<div class="music-seek">
			<span class="t">{fmt(musicPlayer.currentTime)}</span>
			<input
				type="range"
				min="0"
				max={Math.max(1, musicPlayer.duration)}
				step="0.1"
				value={musicPlayer.currentTime}
				oninput={onSeekInput}
				disabled={!isGlobalActive}
				aria-label="탐색"
			/>
			<span class="t">{fmt(musicPlayer.duration)}</span>
		</div>
	</div>
</div>

<style>
	.music-bar {
		/* 노트 최상단(제목 위)에 고정되는 컨트롤 배너 — 텍스트 영역과 별개 컴포넌트라
		   클릭해도 에디터 캐럿이 활성화되지 않는다. 스크롤해도 sticky 로 따라온다
		   (모바일: 페이지 스크롤 기준 / 데스크탑: 비스크롤 .body 안에선 최상단 고정). */
		position: sticky;
		top: 0;
		z-index: 5;
		flex: 0 0 auto;
		background: var(--surface, #fff);
		border: 1px solid var(--border, #ececea);
		border-radius: 8px;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
		margin-bottom: clamp(0.35rem, 1.2vw, 0.6rem);
		padding: clamp(0.5rem, 1.6vw, 0.85rem) clamp(0.6rem, 2.4vw, 1rem);
		display: flex;
		flex-direction: column;
		gap: clamp(0.35rem, 1.2vw, 0.6rem);
	}
	.music-now {
		font-size: clamp(0.72rem, 2.6vw, 0.8rem);
		color: var(--text-muted, #666);
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	.music-now b {
		color: var(--text, #222);
		font-weight: 600;
	}
	.music-empty {
		color: var(--text-muted, #999);
		font-style: italic;
	}
	.music-pl {
		background: var(--accent-soft, #f0e6f0);
		color: var(--accent, #a05);
		border-radius: 5px;
		padding: 1px 6px;
		font-size: 0.86em;
	}
	.music-row {
		display: flex;
		align-items: center;
		gap: clamp(0.5rem, 2vw, 0.9rem);
	}
	.music-btns {
		display: flex;
		align-items: center;
		gap: clamp(0.35rem, 1.4vw, 0.65rem);
	}
	.music-btns button {
		border: none;
		background: transparent;
		color: var(--text, #444);
		font-size: clamp(0.85rem, 3vw, 1rem);
		cursor: pointer;
		width: 1.9em;
		height: 1.9em;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.music-btns button.main {
		background: var(--accent, #a05);
		color: #fff;
		width: 2.3em;
		height: 2.3em;
	}
	.music-btns button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.music-modes {
		display: flex;
		align-items: center;
		gap: clamp(0.2rem, 1vw, 0.4rem);
	}
	.music-modes button.mode {
		border: none;
		background: transparent;
		font-size: clamp(0.8rem, 2.8vw, 0.95rem);
		cursor: pointer;
		width: 1.8em;
		height: 1.8em;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0.45;
		filter: grayscale(1);
	}
	.music-modes button.mode.active {
		opacity: 1;
		filter: none;
		background: var(--accent-soft, #f0e6f0);
	}
	.music-seek {
		flex: 1;
		display: flex;
		align-items: center;
		gap: clamp(0.35rem, 1.4vw, 0.5rem);
	}
	.music-seek input[type='range'] {
		flex: 1;
		accent-color: var(--accent, #a05);
	}
	.music-seek input[type='range']:disabled {
		opacity: 0.5;
	}
	.music-seek .t {
		font-size: clamp(0.62rem, 2.2vw, 0.7rem);
		color: var(--text-muted, #888);
		font-variant-numeric: tabular-nums;
	}
</style>
