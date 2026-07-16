<script lang="ts">
	/** 날짜 노트(`YYYY-MM-DD`) 하단에 붙는 읽기전용 이전 년도 기록 패널.
	 *  에디터 도큐먼트/XML 은 절대 건드리지 않는다(별도 패널). 제목이 날짜가
	 *  아니거나 기록이 없으면 아무것도 렌더하지 않는다. */
	import { onMount } from 'svelte';
	import { onInvalidate } from '$lib/stores/noteListCache.js';
	import {
		loadHistoryChain,
		recordsForDate,
		parseDateTitle,
		type HistoryEntry
	} from './historyChain.js';
	import PrevYearRecords from './PrevYearRecords.svelte';

	interface Props {
		title: string;
	}
	let { title }: Props = $props();

	let records = $state<HistoryEntry[]>([]);
	let token = 0;

	async function load() {
		const d = parseDateTitle(title);
		if (!d) {
			records = [];
			return;
		}
		const t = ++token;
		const chain = await loadHistoryChain();
		if (t !== token) return;
		records = recordsForDate(chain, d.year, d.month, d.day);
	}

	$effect(() => {
		void title;
		void load();
	});
	onMount(() => onInvalidate(() => void load()));
</script>

{#if records.length > 0}
	<div class="date-note-footer">
		<PrevYearRecords {records} />
	</div>
{/if}

<style>
	.date-note-footer {
		flex-shrink: 0;
		border-top: 1px solid #ececec;
		max-height: 40%;
		overflow-y: auto;
		/* 창 하단 플로팅 툴바(--toolbar-h, .note-window 에서 상속)와 겹치지
		   않도록 여유 공간. 에디터 .tiptap 의 padding-bottom 과 같은 취지. */
		margin-bottom: calc(var(--toolbar-h, 30px) + 8px);
	}
</style>
