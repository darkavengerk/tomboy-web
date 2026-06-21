<script lang="ts">
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';

	// onopen: 레일 곡 제목 클릭 시 "재생을 시작한 노트"(묶음이면 묶음, 일반 노트면
	// 그 노트)를 데스크탑 작업공간에 연다. SidePanel 이 host(DesktopWorkspace)로 위임.
	type Props = { onopen?: (guid: string) => void };
	let { onopen }: Props = $props();

	const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

	const track = $derived(musicPlayer.currentTrack);
	const playing = $derived(musicPlayer.isPlaying);

	let timedOut = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	// 재생 중이면 항상 보이고 타이머 해제. 일시정지(곡 있음)면 10분 후 접기.
	$effect(() => {
		if (playing) {
			timedOut = false;
			clearTimer();
		} else if (track && !timer && !timedOut) {
			timer = setTimeout(() => {
				timedOut = true;
				timer = null;
			}, IDLE_TIMEOUT_MS);
		}
	});

	// 언마운트 정리.
	$effect(() => () => clearTimer());

	const visible = $derived(!!track && !timedOut);

	function fmt(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
	function onSeek(e: Event) {
		musicPlayer.requestSeek(Number((e.currentTarget as HTMLInputElement).value));
		// 사용자 상호작용 — 타임아웃 리셋(다시 10분).
		timedOut = false;
		clearTimer();
	}

	// 재생을 시작한 노트가 있으면 곡 제목을 누를 수 있게 한다.
	const originGuid = $derived(musicPlayer.originNoteGuid);
	function openOrigin() {
		if (originGuid) onopen?.(originGuid);
	}
</script>

{#if visible && track}
	<div class="rail-now">
		{#if originGuid && onopen}
			<button
				type="button"
				class="title title-link"
				title="재생을 시작한 노트 열기"
				onclick={openOrigin}>{track.display}</button
			>
		{:else}
			<div class="title" title={track.display}>{track.display}</div>
		{/if}
		<div class="name">{musicPlayer.activeNoteName}</div>
		<div class="seek">
			<span class="t">{fmt(musicPlayer.currentTime)}</span>
			<input
				type="range"
				min="0"
				max={Math.max(1, musicPlayer.duration)}
				step="0.1"
				value={musicPlayer.currentTime}
				oninput={onSeek}
				aria-label="탐색"
			/>
			<span class="t">{fmt(musicPlayer.duration)}</span>
		</div>
	</div>
{/if}

<style>
	.rail-now {
		padding: 8px 12px;
		border-bottom: 1px solid #2a2a2a;
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex-shrink: 0;
		background: #161616;
	}
	.title {
		font-weight: 600;
		font-size: 0.85rem;
		color: #eee;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* 클릭 가능한 제목 — 버튼 기본 스타일 제거하고 좌측 정렬 텍스트로. */
	button.title-link {
		display: block;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		padding: 0;
		margin: 0;
		font-family: inherit;
		cursor: pointer;
	}
	button.title-link:hover {
		color: #fff;
		text-decoration: underline;
	}
	.name {
		font-size: 0.72rem;
		color: #999;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.seek {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.seek input[type='range'] {
		flex: 1;
		min-width: 0;
		accent-color: var(--accent, #a05);
	}
	.seek .t {
		font-size: 0.62rem;
		color: #999;
		font-variant-numeric: tabular-nums;
	}
</style>
