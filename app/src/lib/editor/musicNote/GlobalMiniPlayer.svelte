<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
	import { miniPlayerVisible } from './miniPlayerVisibility.js';

	// 현재 페이지의 노트 guid(/note/[id]). 그 외 라우트는 null.
	const currentNoteGuid = $derived(page.params.id ?? null);
	const visible = $derived(
		miniPlayerVisible(musicPlayer.activeNoteGuid, musicPlayer.queue.length, currentNoteGuid)
	);

	let expanded = $state(false);

	// 드래그 위치(localStorage 기억). 기본 우하단.
	const POS_KEY = 'tomboy.miniPlayerPos';
	function loadPos(): { x: number; y: number } | null {
		try {
			const raw = window.localStorage.getItem(POS_KEY);
			if (!raw) return null;
			const p = JSON.parse(raw);
			if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
		} catch {
			/* ignore */
		}
		return null;
	}
	let pos = $state<{ x: number; y: number } | null>(null);
	$effect(() => {
		if (pos === null && typeof window !== 'undefined') pos = loadPos();
	});

	let dragging = false;
	let dragDX = 0;
	let dragDY = 0;
	let moved = false;
	function onPointerDown(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		dragging = true;
		moved = false;
		dragDX = e.clientX - r.left;
		dragDY = e.clientY - r.top;
		el.setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		moved = true;
		const x = Math.max(4, Math.min(e.clientX - dragDX, window.innerWidth - 60));
		const y = Math.max(4, Math.min(e.clientY - dragDY, window.innerHeight - 60));
		pos = { x, y };
	}
	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		if (pos) {
			try {
				window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
			} catch {
				/* ignore */
			}
		}
	}

	const track = $derived(musicPlayer.currentTrack);
	const playing = $derived(musicPlayer.isPlaying);

	function onTogglePill(e: MouseEvent) {
		if (moved) {
			e.preventDefault();
			return;
		}
		expanded = !expanded;
	}
	function onPlayPause() {
		musicPlayer.toggle();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function onPrev() {
		musicPlayer.prev();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function onNext() {
		musicPlayer.next();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function onStop() {
		musicPlayer.stop();
		expanded = false;
	}
	function onSeek(e: Event) {
		musicPlayer.requestSeek(Number((e.currentTarget as HTMLInputElement).value));
	}
	function onOpenNote() {
		const g = musicPlayer.activeNoteGuid;
		if (g) void goto('/note/' + g);
		expanded = false;
	}
	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
</script>

{#if visible && track}
	<div
		class="mini"
		class:expanded
		style={pos ? `left:${pos.x}px; top:${pos.y}px; right:auto; bottom:auto;` : ''}
	>
		{#if expanded}
			<div class="mini-card">
				<button type="button" class="note-link" onclick={onOpenNote} title="노트 열기">
					<b>{track.display}</b>
					<span class="note-name">{musicPlayer.activeNoteName}</span>
				</button>
				<div class="mini-transport">
					<button type="button" onclick={onPrev} aria-label="이전">⏮</button>
					<button type="button" class="main" onclick={onPlayPause} aria-label={playing ? '일시정지' : '재생'}>{playing ? '⏸' : '▶'}</button>
					<button type="button" onclick={onNext} aria-label="다음">⏭</button>
				</div>
				<div class="mini-seek">
					<span class="t">{fmt(musicPlayer.currentTime)}</span>
					<input type="range" min="0" max={Math.max(1, musicPlayer.duration)} step="0.1" value={musicPlayer.currentTime} oninput={onSeek} aria-label="탐색" />
					<span class="t">{fmt(musicPlayer.duration)}</span>
				</div>
				<div class="mini-foot">
					<button type="button" class="open-btn" onclick={onOpenNote}>노트 열기</button>
					<button type="button" class="collapse" onclick={() => (expanded = false)} aria-label="접기">▾</button>
				</div>
			</div>
		{:else}
			<div
				class="pill"
				role="button"
				tabindex="0"
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onclick={onTogglePill}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onTogglePill(e as unknown as MouseEvent); }}
			>
				<span class="pill-icon">♪</span>
				<button type="button" class="pill-pp" onclick={(e) => { e.stopPropagation(); onPlayPause(); }} aria-label={playing ? '일시정지' : '재생'}>{playing ? '⏸' : '▶'}</button>
				<button type="button" class="pill-x" onclick={(e) => { e.stopPropagation(); onStop(); }} aria-label="정지">✕</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.mini {
		position: fixed;
		right: clamp(0.6rem, 3vw, 1.2rem);
		/* GlobalMiniPlayer 는 .app-shell 형제로 마운트돼 --topnav-height 가 상속되지 않는다.
		   pill 은 하단 고정이라 nav 오프셋이 필요 없다 — 화면 우하단에 단순 고정. */
		bottom: clamp(0.6rem, 3vw, 1.2rem);
		z-index: var(--z-miniplayer);
	}
	.pill {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: var(--surface, #fff);
		border: 1px solid var(--border, #ececea);
		border-radius: 999px;
		box-shadow: 0 3px 10px rgba(0, 0, 0, 0.18);
		padding: 0.3rem 0.5rem;
		cursor: grab;
		touch-action: none;
		user-select: none;
	}
	.pill-icon {
		color: var(--accent, #a05);
		font-size: 1rem;
	}
	.pill button,
	.mini-transport button,
	.mini-foot button {
		border: none;
		background: transparent;
		cursor: pointer;
		font-size: 0.95rem;
		color: var(--text, #333);
		width: 1.9em;
		height: 1.9em;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.pill-pp,
	.mini-transport .main {
		background: var(--accent, #a05);
		color: #fff;
	}
	.mini-card {
		background: var(--surface, #fff);
		border: 1px solid var(--border, #ececea);
		border-radius: 12px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
		padding: 0.7rem 0.8rem;
		width: min(78vw, 320px);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.note-link {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		width: 100%;
	}
	.note-link b {
		color: var(--text, #222);
	}
	.note-name {
		font-size: 0.72rem;
		color: var(--text-muted, #777);
	}
	.mini-transport {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
	}
	.mini-seek {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.mini-seek input[type='range'] {
		flex: 1;
		accent-color: var(--accent, #a05);
	}
	.mini-seek .t {
		font-size: 0.65rem;
		color: var(--text-muted, #888);
		font-variant-numeric: tabular-nums;
	}
	.mini-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.open-btn {
		width: auto;
		border-radius: 8px;
		padding: 0.25rem 0.7rem;
		background: var(--accent-soft, #f0e6f0);
		color: var(--accent, #a05);
		font-size: 0.8rem;
	}
</style>
