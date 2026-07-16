<script lang="ts">
	/** 이전 년도 같은 날짜 기록 — 년도별 그룹, 우측정렬·흐리게. 입력은 이미
	 *  필터(연도<대상)·정렬(연도 내림차순)된 records. */
	import type { HistoryEntry } from './historyChain.js';

	interface Props {
		records: HistoryEntry[];
	}
	let { records }: Props = $props();

	const groups = $derived.by(() => {
		const m = new Map<number, HistoryEntry[]>();
		for (const r of records) {
			const b = m.get(r.year);
			if (b) b.push(r);
			else m.set(r.year, [r]);
		}
		// records 가 이미 연도 내림차순 → Map 삽입순서가 그대로 내림차순.
		return [...m.entries()];
	});
</script>

{#if records.length > 0}
	<div class="prev-years">
		{#each groups as [year, items] (year)}
			<div class="py-group">
				<span class="py-year">{year}</span>
				<ul class="py-list">
					{#each items as it, i (i)}
						<li>{it.label}</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
{/if}

<style>
	.prev-years {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 10px;
		text-align: right;
		color: #9aa0a6;
		font-size: 0.72rem;
		line-height: 1.35;
	}
	.py-group {
		display: flex;
		align-items: baseline;
		justify-content: flex-end;
		gap: 6px;
	}
	.py-year {
		flex-shrink: 0;
		font-weight: 700;
		color: #b0b4b8;
	}
	.py-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.py-list li {
		white-space: normal;
		word-break: break-word;
	}
</style>
