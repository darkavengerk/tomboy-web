<script lang="ts">
	/** 사건·사고·기념 이벤트 — 기념일 강조 배지 목록. 입력은 이미 필터
	 *  (연도<=대상)·정렬(연도 내림차순)된 records. 히스토리(PrevYearRecords)와
	 *  달리 앰버 배경 하이라이트로 강조한다. */
	import type { EventEntry } from './eventEntries.js';

	interface Props {
		records: EventEntry[];
	}
	let { records }: Props = $props();
</script>

{#if records.length > 0}
	<div class="events">
		<span class="events-title">기념 기록</span>
		<ul class="events-list">
			{#each records as r, i (i)}
				<li class="event-item"><b>{r.year}</b> {r.label}</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.events {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
	}
	.events-title {
		font-size: 0.7rem;
		font-weight: 700;
		color: #995f00;
		letter-spacing: 0.04em;
	}
	.events-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.event-item {
		font-size: 0.8rem;
		line-height: 1.35;
		color: #7a4e00;
		background: #fdecc4;
		border-left: 3px solid #e8a33d;
		border-radius: 3px;
		padding: 2px 8px;
		white-space: normal;
		word-break: break-word;
		font-weight: 600;
	}
	.event-item b {
		font-weight: 800;
		color: #995f00;
		margin-right: 3px;
	}
</style>
