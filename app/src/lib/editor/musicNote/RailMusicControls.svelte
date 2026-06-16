<script lang="ts">
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';

	const hasSession = $derived(musicPlayer.queue.length > 0);
	const playing = $derived(musicPlayer.isPlaying);

	function onPlayPause() {
		musicPlayer.resumeOrRestart();
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
</script>

<div class="rail-music" role="group" aria-label="음악 재생">
	<button type="button" onclick={onPrev} disabled={!hasSession} aria-label="이전 곡">⏮</button>
	<button
		type="button"
		class="play"
		onclick={onPlayPause}
		disabled={!hasSession}
		aria-label={playing ? '일시정지' : '재생'}
	>{playing ? '⏸' : '▶'}</button>
	<button type="button" onclick={onNext} disabled={!hasSession} aria-label="다음 곡">⏭</button>
</div>

<style>
	.rail-music {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2px;
		width: calc(100% - 12px);
		flex-shrink: 0;
	}
	.rail-music button {
		flex: 1 1 0;
		min-width: 0;
		height: 26px;
		border: 1px solid #2a2a2a;
		background: #111;
		color: #ddd;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.rail-music button:hover:not(:disabled) {
		background: #232323;
		color: #fff;
	}
	.rail-music button.play {
		background: var(--accent, #a05);
		color: #fff;
		border-color: var(--accent, #a05);
	}
	.rail-music button:disabled {
		opacity: 0.35;
		cursor: default;
	}
</style>
