<script lang="ts">
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
	import { desktopSession } from '$lib/desktop/session.svelte.js';
	import { desktopMiniPlayerVisible } from './miniPlayerVisibility.js';

	const openGuids = $derived(new Set(desktopSession.windows.map((w) => w.guid)));
	const visible = $derived(
		desktopMiniPlayerVisible(musicPlayer.activeNoteGuid, musicPlayer.queue.length, openGuids)
	);
	const track = $derived(musicPlayer.currentTrack);
	const playing = $derived(musicPlayer.isPlaying);

	let pos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
	let placed = false;
	$effect(() => {
		if (!placed && typeof window !== 'undefined') {
			placed = true;
			pos = { x: Math.round(window.innerWidth / 2 - 150), y: Math.round(window.innerHeight / 2 - 70) };
		}
	});

	let dragging = false;
	let dragDX = 0;
	let dragDY = 0;
	function onPointerDown(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		dragging = true;
		dragDX = e.clientX - r.left;
		dragDY = e.clientY - r.top;
		el.setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		pos = {
			x: Math.max(0, Math.min(e.clientX - dragDX, window.innerWidth - 80)),
			y: Math.max(0, Math.min(e.clientY - dragDY, window.innerHeight - 40))
		};
	}
	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
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
	function onSeek(e: Event) {
		musicPlayer.requestSeek(Number((e.currentTarget as HTMLInputElement).value));
	}
	function onOpenNote() {
		const g = musicPlayer.activeNoteGuid;
		if (g) desktopSession.openWindow(g);
	}
	function onStop() {
		musicPlayer.stop();
	}
	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
</script>

{#if visible && track}
	<div class="dmini" style={`left:${pos.x}px; top:${pos.y}px;`}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="dmini-grip"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
		>
			<span class="now">♪ 재생 중</span>
			<button type="button" class="x" onclick={onStop} aria-label="정지">✕</button>
		</div>
		<div class="title">{track.display}</div>
		<div class="name">{musicPlayer.activeNoteName}</div>
		<div class="transport">
			<button type="button" onclick={onPrev} aria-label="이전">⏮</button>
			<button type="button" class="main" onclick={onPlayPause} aria-label={playing ? '일시정지' : '재생'}>{playing ? '⏸' : '▶'}</button>
			<button type="button" onclick={onNext} aria-label="다음">⏭</button>
			<button type="button" class="open" onclick={onOpenNote}>노트 열기</button>
		</div>
		<div class="seek">
			<span class="t">{fmt(musicPlayer.currentTime)}</span>
			<input type="range" min="0" max={Math.max(1, musicPlayer.duration)} step="0.1" value={musicPlayer.currentTime} oninput={onSeek} aria-label="탐색" />
			<span class="t">{fmt(musicPlayer.duration)}</span>
		</div>
	</div>
{/if}

<style>
	.dmini {
		position: fixed;
		width: 300px;
		background: #1e1e1e;
		color: #eee;
		border: 1px solid #3a3a3a;
		border-radius: 12px;
		box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
		padding: 0.6rem 0.8rem 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		/* .desktop-root 안에서 .canvas 뒤 형제로 놓여 창 위에 표시된다. */
	}
	.dmini-grip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		cursor: grab;
		touch-action: none;
		user-select: none;
		margin: -0.2rem -0.2rem 0;
	}
	.now {
		font-size: 0.72rem;
		color: #b98;
	}
	.title {
		font-weight: 600;
	}
	.name {
		font-size: 0.72rem;
		color: #999;
	}
	.transport {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.transport button,
	.dmini-grip .x {
		border: none;
		background: transparent;
		color: #eee;
		cursor: pointer;
		font-size: 0.95rem;
		width: 1.9em;
		height: 1.9em;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.transport .main {
		background: var(--accent, #a05);
		color: #fff;
	}
	.transport .open {
		width: auto;
		border-radius: 8px;
		padding: 0.2rem 0.6rem;
		background: #333;
		font-size: 0.78rem;
		margin-left: auto;
	}
	.seek {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.seek input[type='range'] {
		flex: 1;
		accent-color: var(--accent, #a05);
	}
	.seek .t {
		font-size: 0.65rem;
		color: #999;
		font-variant-numeric: tabular-nums;
	}
</style>
