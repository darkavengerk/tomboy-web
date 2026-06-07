<script lang="ts">
	import { untrack } from 'svelte';
	import type { Editor } from '@tiptap/core';
	import { parseMusicNote } from '$lib/music/parseMusicNote.js';
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
	import { modKeys } from '$lib/desktop/modKeys.svelte.js';

	// 순수 뷰. 오디오 재생은 전역 엔진(musicAudio.svelte.ts, +layout 설치)이 단일
	// <audio> 로 담당한다. 이 컴포넌트는 musicPlayer(싱글톤)를 읽어 표시/조작만 한다.
	// 여러 패널이 떠 있어도 모두 같은 글로벌 상태를 본다.
	type Props = { editor: Editor; guid: string };
	let { editor, guid }: Props = $props();

	let version = $state(0);
	let refreshN = 0;
	let barEl = $state<HTMLElement | null>(null);

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

	// 재생/Ctrl 상태 변화 → 에디터 데코 갱신(no-op tr). 에디터별로 필요(트랙 강조).
	$effect(() => {
		musicPlayer.currentIndex;
		musicPlayer.isPlaying;
		modKeys.ctrl;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(ed.state.tr.setMeta('musicRefresh', (refreshN = (refreshN + 1) | 0)));
	});

	// 패널을 제목(에디터 첫 줄) 바로 아래에 띄운다. 제목 높이를 측정해 top 을 잡고,
	// 패널 높이를 --music-reserve 로 에디터에 알려 첫 블록 margin-bottom 으로 공간 확보.
	// (제목이 줄바꿈돼도 측정으로 따라감.) jsdom 엔 레이아웃/ResizeObserver 가 없어 no-op.
	$effect(() => {
		version; // 제목 변화 시 재측정
		const bar = barEl;
		const view = editor.view;
		if (!bar || !view) return;
		const compute = () => {
			const titleEl = view.dom.firstElementChild as HTMLElement | null;
			const parent = bar.offsetParent as HTMLElement | null;
			if (!titleEl || !parent) return;
			const top = titleEl.getBoundingClientRect().bottom - parent.getBoundingClientRect().top;
			bar.style.top = `${Math.max(0, top)}px`;
			view.dom.style.setProperty('--music-reserve', `${bar.offsetHeight}px`);
		};
		compute();
		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== 'undefined') {
			ro = new ResizeObserver(compute);
			const titleEl = view.dom.firstElementChild;
			if (titleEl) ro.observe(titleEl);
			ro.observe(bar);
		}
		window.addEventListener('resize', compute);
		return () => {
			ro?.disconnect();
			window.removeEventListener('resize', compute);
			view.dom?.style.removeProperty('--music-reserve');
		};
	});

	// 표시 대상: 글로벌 현재 곡(재생/일시정지 중) 우선, 없으면 이 노트의 첫 곡 미리보기.
	const globalTrack = $derived(musicPlayer.currentTrack);
	const localFirst = $derived(parsedNote.flatQueue[0] ?? null);
	const isGlobalActive = $derived(globalTrack !== null);
	const shown = $derived(globalTrack ?? localFirst);
	const playing = $derived(musicPlayer.isPlaying);
	const label = $derived(shown?.playlistLabel ?? '');
	const statusText = $derived(isGlobalActive ? (playing ? '재생 중' : '일시정지') : '대기');

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

<div class="music-bar" bind:this={barEl}>
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
		/* 제목 줄 바로 아래에 떠 있는 컨트롤 패널. top 은 측정값으로 인라인 지정.
		   offsetParent 는 .editor-area(모바일)/.body(데스크탑) — 둘 다 position:relative. */
		position: absolute;
		left: 0;
		right: 0;
		top: 0;
		z-index: 6;
		background: var(--surface, #fff);
		border: 1px solid var(--border, #ececea);
		border-radius: 8px;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
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
