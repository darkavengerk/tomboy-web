<script lang="ts">
	import { untrack } from 'svelte';
	import type { Editor } from '@tiptap/core';
	import { parseMusicNote } from '$lib/music/parseMusicNote.js';
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { modKeys } from '$lib/desktop/modKeys.svelte.js';

	type Props = { editor: Editor; guid: string };
	let { editor, guid }: Props = $props();

	let audioEl = $state<HTMLAudioElement | null>(null);
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

	// doc 변경마다 재파싱 → 스토어 큐 갱신.
	// setQueue 가 읽는 player $state(queue/currentIndex/activeNoteGuid)를 같은 이펙트에서
	// 다시 쓰므로 untrack 으로 자기-구독을 끊는다. 의존성은 version(=doc 변경)뿐.
	$effect(() => {
		version; // subscribe
		const note = parseMusicNote(editor.state.doc);
		untrack(() => musicPlayer.setQueue(guid, note.flatQueue));
	});

	const track = $derived(musicPlayer.currentTrack);
	const playing = $derived(musicPlayer.isPlaying);

	const label = $derived.by(() => {
		version;
		const url = track?.url;
		if (!url) return '';
		const note = parseMusicNote(editor.state.doc);
		for (const pl of note.playlists) if (pl.tracks.some((t) => t.url === url)) return pl.label;
		return '';
	});

	// <audio> src 동기화.
	$effect(() => {
		const el = audioEl;
		const url = track?.url ?? '';
		if (!el) return;
		if ((el.getAttribute('src') ?? '') !== url) {
			if (url) el.src = url;
			else el.removeAttribute('src');
		}
	});
	// 재생/일시정지 동기화.
	$effect(() => {
		const el = audioEl;
		if (!el) return;
		if (playing) void el.play().catch(() => {});
		else el.pause();
	});
	// seek 요청 적용.
	$effect(() => {
		const el = audioEl;
		musicPlayer.seekToken; // subscribe
		if (!el) return;
		const target = musicPlayer.pendingSeekTime;
		if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
	});
	// 재생/Ctrl 상태 변화 → 에디터 데코 갱신(no-op tr).
	$effect(() => {
		musicPlayer.currentIndex;
		musicPlayer.isPlaying;
		modKeys.ctrl;
		const ed = editor;
		if (!ed || ed.isDestroyed) return;
		ed.view.dispatch(ed.state.tr.setMeta('musicRefresh', (refreshN = (refreshN + 1) | 0)));
	});

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

{#if track}
	<div class="music-bar">
		<div class="music-now">
			재생 중
			{#if label}<span class="music-pl">{label}</span>{/if}
			<b>{track.display}</b>
		</div>
		<div class="music-row">
			<div class="music-btns">
				<button type="button" onclick={() => musicPlayer.prev()} aria-label="이전">⏮</button>
				<button
					type="button"
					class="main"
					onclick={() => musicPlayer.toggle()}
					aria-label={playing ? '일시정지' : '재생'}>{playing ? '⏸' : '▶'}</button
				>
				<button type="button" onclick={() => musicPlayer.next()} aria-label="다음">⏭</button>
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
					aria-label="탐색"
				/>
				<span class="t">{fmt(musicPlayer.duration)}</span>
			</div>
		</div>
	</div>
{/if}
<audio
	bind:this={audioEl}
	preload="metadata"
	ontimeupdate={() => musicPlayer.reportTime(audioEl?.currentTime ?? 0)}
	onloadedmetadata={() => musicPlayer.reportDuration(audioEl?.duration ?? 0)}
	onended={() => musicPlayer.reportEnded()}
	onerror={() => musicPlayer.next()}
></audio>

<style>
	.music-bar {
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--surface, #fff);
		border-bottom: 1px solid var(--border, #ececea);
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
	.music-seek .t {
		font-size: clamp(0.62rem, 2.2vw, 0.7rem);
		color: var(--text-muted, #888);
		font-variant-numeric: tabular-nums;
	}
	audio {
		display: none;
	}
</style>
