<script lang="ts">
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
	import { getGlobalLatest, resumeGlobalLatest } from '$lib/music/musicControl.svelte.js';
	import { continuityChoice } from '$lib/music/continuity.js';
	import MusicContinuityPicker from './MusicContinuityPicker.svelte';

	const hasSession = $derived(musicPlayer.queue.length > 0);
	const playing = $derived(musicPlayer.isPlaying);
	let menuOpen = $state(false);

	function remote() {
		return getGlobalLatest();
	}

	async function pickRemote() {
		menuOpen = false;
		const ok = await resumeGlobalLatest();
		if (ok && musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function pickLocal() {
		menuOpen = false;
		musicPlayer.resumeOrRestart();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}

	function onPlayPause() {
		if (playing) {
			musicPlayer.pause();
			return;
		}
		const r = remote();
		const choice = continuityChoice({
			localTrackUrl: musicPlayer.currentTrack?.url ?? null,
			remoteTrackUrl: r?.trackUrl ?? null
		});
		if (choice === 'both') {
			menuOpen = true;
			return;
		}
		if (choice === 'remote') {
			void pickRemote();
			return;
		}
		pickLocal();
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
		disabled={!hasSession && !remote()}
		aria-label={playing ? '일시정지' : '재생'}
	>{playing ? '⏸' : '▶'}</button>
	<button type="button" onclick={onNext} disabled={!hasSession} aria-label="다음 곡">⏭</button>
</div>

{#if menuOpen}
	<div class="rail-menu">
		<MusicContinuityPicker
			localTitle={musicPlayer.currentTrack?.display ?? ''}
			remoteTitle={remote()?.trackTitle ?? ''}
			remoteDeviceName={remote()?.deviceName ?? '다른 기기'}
			onpick={(w) => (w === 'remote' ? pickRemote() : pickLocal())}
			oncancel={() => (menuOpen = false)}
		/>
	</div>
{/if}

<style>
	.rail-music {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2px;
		width: 100%;
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
	/* Flyout to the RIGHT of the narrow rail (popping up would clip against the
	   viewport top). Vertically centred on the transport controls. The shared
	   MusicContinuityPicker reads var(--color-*) — re-point those to the rail's
	   dark palette here so the card matches the dark rail instead of inheriting
	   the app's light theme (mobile sheet keeps the light theme, untouched). */
	.rail-menu {
		position: absolute;
		left: 100%;
		top: 50%;
		transform: translateY(-50%);
		margin-left: 10px;
		width: 230px;
		z-index: var(--z-menu);
		background: #1f1f1f;
		border: 1px solid #333;
		border-radius: 10px;
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
		--color-bg: #2a2a2a;
		--color-text: #eee;
		--color-text-secondary: #aaa;
		--color-border: #3a3a3a;
	}
	/* Left-pointing caret bridging the rail and the flyout. */
	.rail-menu::before {
		content: '';
		position: absolute;
		right: 100%;
		top: 50%;
		transform: translateY(-50%);
		border: 6px solid transparent;
		border-right-color: #1f1f1f;
	}
</style>
