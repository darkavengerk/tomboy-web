<script lang="ts">
	import type { MusicControlRecord, TransportState } from '$lib/music/musicControlNote.js';

	let {
		records,
		localDeviceId = null
	}: {
		records: MusicControlRecord[];
		localDeviceId?: string | null;
	} = $props();

	// Most-recently-active device first.
	const sorted = $derived(
		[...records].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
	);

	const STATE_LABEL: Record<TransportState, string> = {
		playing: '재생 중',
		paused: '일시정지',
		stopped: '정지'
	};

	function relTime(iso: string): string {
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) return '';
		const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
		if (sec < 60) return '방금 전';
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}분 전`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}시간 전`;
		const day = Math.floor(hr / 24);
		if (day < 30) return `${day}일 전`;
		return new Date(iso).toLocaleDateString('ko-KR');
	}
</script>

<div class="control-view">
	<header class="head">
		<h1>음악 제어</h1>
		<p class="sub">기기별 마지막 재생 상태</p>
	</header>

	{#if sorted.length === 0}
		<p class="empty">아직 기록된 기기가 없습니다.</p>
	{:else}
		<ul class="cards">
			{#each sorted as r (r.deviceId)}
				<li class="card" class:is-me={r.deviceId === localDeviceId}>
					<div class="row top">
						<span class="device">
							{r.deviceName || '기기'}
							{#if r.deviceId === localDeviceId}<span class="me">이 기기</span>{/if}
						</span>
						<span class="state" data-state={r.state}>{STATE_LABEL[r.state]}</span>
					</div>
					<div class="track">{r.trackTitle || r.trackUrl}</div>
					<div class="row bottom">
						<span class="src">{r.noteTitle || ''}</span>
						<span class="when">{relTime(r.updatedAt)}</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<p class="footer">자동 생성·동기화되는 노트입니다. 편집할 수 없습니다.</p>
</div>

<style>
	.control-view {
		max-width: 640px;
		margin: 0 auto;
		padding: clamp(12px, 4vw, 24px);
		color: var(--color-text, #eee);
	}
	.head h1 {
		font-size: 1.3rem;
		font-weight: 700;
		margin: 0;
	}
	.head .sub {
		margin: 2px 0 16px;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #999);
	}
	.empty {
		color: var(--color-text-secondary, #999);
		font-size: 0.9rem;
		padding: 24px 0;
		text-align: center;
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.card {
		border: 1px solid var(--color-border, #333);
		border-radius: 12px;
		padding: 12px 14px;
		background: var(--color-bg-subtle, rgba(255, 255, 255, 0.03));
	}
	.card.is-me {
		border-color: var(--accent, #a05);
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.device {
		font-size: 0.9rem;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.me {
		font-size: 0.68rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--accent, #a05);
		color: #fff;
	}
	.state {
		font-size: 0.72rem;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 999px;
		white-space: nowrap;
		background: var(--color-border, #333);
		color: var(--color-text-secondary, #bbb);
	}
	.state[data-state='playing'] {
		background: rgba(40, 160, 90, 0.22);
		color: #4cc88a;
	}
	.state[data-state='paused'] {
		background: rgba(200, 160, 40, 0.18);
		color: #d8b24a;
	}
	.track {
		margin: 8px 0 6px;
		font-size: 1rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bottom {
		font-size: 0.78rem;
		color: var(--color-text-secondary, #999);
	}
	.src {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.when {
		white-space: nowrap;
		flex-shrink: 0;
	}
	.footer {
		margin-top: 18px;
		font-size: 0.75rem;
		color: var(--color-text-secondary, #888);
		text-align: center;
	}
</style>
