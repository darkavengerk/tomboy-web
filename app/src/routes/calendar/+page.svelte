<script lang="ts">
	/**
	 * 모바일 달력 페이지. 상단 네비 「달력」 항목의 목적지. 데스크탑 달력 창과
	 * 같은 CalendarView 본체를 풀페이지로 띄운다 — 노트가 아니라 위젯이라
	 * 저장/동기화되지 않는다. 다이어리 모드는 뷰포트가 충분히 클 때만(데스크탑
	 * 창 임계와 동일) 자동 발동한다. 날짜를 누르면 그날 노트를 풀스크린 번들로
	 * 보여주고, 항목을 꺼내면 해당 노트로 이동한다.
	 */
	import { goto } from '$app/navigation';
	import CalendarView from '$lib/desktop/calendar/CalendarView.svelte';
	import DayNotesBundleOverlay from '$lib/desktop/DayNotesBundleOverlay.svelte';
	import { findNoteByTitle } from '$lib/storage/noteStore.js';
	import type { CalendarNote } from '$lib/desktop/calendar/groupNotesByCreateDay.js';

	let vw = $state(0);
	let vh = $state(0);
	const diary = $derived(vw >= 460 && vh >= 560);

	let selectedDate = $state<string | null>(null);
	let selectedNotes = $state<CalendarNote[]>([]);

	function handleDaySelect(date: string, notes: CalendarNote[]) {
		selectedDate = date;
		selectedNotes = notes;
	}

	async function openNote(title: string) {
		const note = await findNoteByTitle(title);
		if (note) void goto(`/note/${note.guid}?from=calendar`);
	}
</script>

<svelte:head><title>달력</title></svelte:head>
<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

<div class="calendar-page">
	<CalendarView {diary} ondayselect={handleDaySelect} />
</div>

{#if selectedDate}
	<DayNotesBundleOverlay
		windowed={false}
		date={selectedDate}
		notes={selectedNotes}
		onclose={() => (selectedDate = null)}
		onopennote={openNote}
	/>
{/if}

<style>
	.calendar-page {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
</style>
