<script lang="ts">
	/**
	 * 달력 위젯 창. 노트가 아니라 위젯 — IndexedDB에 저장되지 않고 동기화되지
	 * 않는다(desktopSession의 sentinel-guid 창일 뿐, pose만 영속). 월별 그리드로
	 * 날짜를 보여주고 각 셀에 그날 생성된 노트 개수를 배지로 표시한다. 개수>0인
	 * 날짜를 누르면 그날 노트들을 역참조 번들과 동일한 떠다니는 창으로 띄운다.
	 */
	import { onMount } from 'svelte';
	import { startPointerDrag } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';
	import DayNotesBundleOverlay from './DayNotesBundleOverlay.svelte';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		CALENDAR_WIDGET_GUID,
		desktopSession
	} from './session.svelte.js';
	import { listNotes } from '$lib/core/noteManager.js';
	import { onInvalidate } from '$lib/stores/noteListCache.js';
	import {
		groupNotesByCreateDay,
		localDayKey,
		type CalendarNote
	} from './calendar/groupNotesByCreateDay.js';
	import { buildMonthCells, type MonthCell } from './calendar/monthGrid.js';

	interface Props {
		x: number;
		y: number;
		width: number;
		height: number;
		z: number;
		pinned?: boolean;
		/** Hidden via CSS when the owning workspace isn't visible. */
		active?: boolean;
		onfocus: (guid: string) => void;
		onclose: (guid: string) => void;
		onmove: (guid: string, x: number, y: number) => void;
		onresize: (guid: string, width: number, height: number) => void;
	}

	let {
		x,
		y,
		width,
		height,
		z,
		pinned = false,
		active = true,
		onfocus,
		onclose,
		onmove,
		onresize
	}: Props = $props();

	const guid = CALENDAR_WIDGET_GUID;
	const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

	let notes = $state<CalendarNote[]>([]);
	const dayMap = $derived(groupNotesByCreateDay(notes));

	const today = new Date();
	const todayKey = localDayKey(today);
	let viewYear = $state(today.getFullYear());
	let viewMonth = $state(today.getMonth()); // 0-based
	let selectedDate = $state<string | null>(null);

	// 42 셀(6주 × 7일) — 이번 달 1일이 속한 주의 일요일부터.
	const cells = $derived(buildMonthCells(viewYear, viewMonth, todayKey, dayMap));

	const selectedNotes = $derived(selectedDate ? (dayMap.get(selectedDate) ?? []) : []);

	async function loadNotes() {
		const all = await listNotes();
		notes = all.map((n) => ({ guid: n.guid, title: n.title, createDate: n.createDate }));
	}

	onMount(() => {
		void loadNotes();
		// 어떤 노트든 생성/삭제/변경으로 목록 캐시가 무효화되면 개수를 다시 계산.
		return onInvalidate(() => void loadNotes());
	});

	function prevMonth() {
		if (viewMonth === 0) {
			viewYear -= 1;
			viewMonth = 11;
		} else {
			viewMonth -= 1;
		}
	}

	function nextMonth() {
		if (viewMonth === 11) {
			viewYear += 1;
			viewMonth = 0;
		} else {
			viewMonth += 1;
		}
	}

	function goToday() {
		viewYear = today.getFullYear();
		viewMonth = today.getMonth();
	}

	function clickCell(cell: MonthCell) {
		// 넘침 셀 → 해당 달로 이동.
		if (!cell.inMonth) {
			viewYear = cell.date.getFullYear();
			viewMonth = cell.date.getMonth();
			return;
		}
		if (cell.count > 0) selectedDate = cell.key;
	}

	function handleFocus() {
		onfocus(guid);
	}

	function handleClose() {
		onclose(guid);
	}

	function startDrag(e: PointerEvent) {
		const targetEl = e.target as HTMLElement | null;
		if (targetEl?.closest('[data-no-drag]')) return;
		onfocus(guid);
		const origX = x;
		const origY = y;
		startPointerDrag(e, {
			onMove: (dx, dy) => onmove(guid, origX + dx, origY + dy)
		});
	}

	function handlePinToggle(e: MouseEvent) {
		e.stopPropagation();
		desktopSession.togglePin(guid);
	}

	function handleTitleBarAuxClick(e: MouseEvent) {
		if (e.button === 1) {
			e.preventDefault();
			desktopSession.sendToBack(guid);
		}
	}

	function openNote(title: string) {
		void desktopSession.openByTitle(title);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="calendar-window"
	class:hidden={!active}
	style="left:{x}px; top:{y}px; width:{width}px; height:{height}px; z-index:{z};"
	onpointerdowncapture={handleFocus}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="title-bar" onpointerdown={startDrag} onauxclick={handleTitleBarAuxClick}>
		<span class="title-text">달력</span>
		<button
			type="button"
			class="pin-btn"
			class:pinned
			onclick={handlePinToggle}
			aria-label={pinned ? '항상 위 해제' : '항상 위'}
			title={pinned ? '항상 위 해제' : '항상 위'}
			data-no-drag>&#x1F4CC;</button
		>
		<button type="button" class="close-btn" onclick={handleClose} aria-label="창 닫기" data-no-drag
			>✕</button
		>
	</div>

	<div class="body">
		<div class="nav" data-no-drag>
			<button type="button" class="nav-btn" onclick={prevMonth} aria-label="이전 달">◀</button>
			<button type="button" class="nav-label" onclick={goToday} title="오늘로">
				{viewYear}년 {viewMonth + 1}월
			</button>
			<button type="button" class="nav-btn" onclick={nextMonth} aria-label="다음 달">▶</button>
		</div>

		<div class="grid weekday-row">
			{#each WEEKDAYS as w, i (w)}
				<div class="weekday" class:sun={i === 0} class:sat={i === 6}>{w}</div>
			{/each}
		</div>

		<div class="grid days">
			{#each cells as cell (cell.key)}
				<button
					type="button"
					class="cell"
					class:out={!cell.inMonth}
					class:today={cell.isToday}
					class:has={cell.count > 0}
					class:sun={cell.date.getDay() === 0}
					class:sat={cell.date.getDay() === 6}
					onclick={() => clickCell(cell)}
					data-no-drag
				>
					<span class="cell-day">{cell.day}</span>
					{#if cell.count > 0}
						<span class="cell-count">{cell.count}</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	<ResizeHandles
		base={() => ({ x, y, width, height })}
		min={{ width: DESKTOP_WINDOW_MIN_WIDTH, height: DESKTOP_WINDOW_MIN_HEIGHT }}
		onresize={(g) => desktopSession.updateGeometry(guid, g)}
	/>
</div>

{#if selectedDate}
	<DayNotesBundleOverlay
		date={selectedDate}
		notes={selectedNotes}
		onclose={() => (selectedDate = null)}
		onopennote={openNote}
	/>
{/if}

<style>
	.calendar-window {
		position: absolute;
		display: flex;
		flex-direction: column;
		background: #fff;
		color: #111;
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		overflow: hidden;
		min-width: 280px;
		min-height: 240px;
	}

	.calendar-window.hidden {
		display: none;
	}

	.title-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		background: #2a2a2a;
		color: #eee;
		cursor: grab;
		user-select: none;
		touch-action: none;
		flex-shrink: 0;
	}

	.title-bar:active {
		cursor: grabbing;
	}

	.title-text {
		flex: 1;
		font-size: 0.85rem;
		font-weight: 500;
	}

	.pin-btn,
	.close-btn {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		font-size: 0.8rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 3px;
	}

	.pin-btn {
		color: #888;
		opacity: 0.5;
	}

	.pin-btn:hover,
	.pin-btn.pinned {
		opacity: 1;
		background: rgba(255, 255, 255, 0.15);
		color: #fff;
	}

	.close-btn {
		color: #ccc;
	}

	.close-btn:hover {
		background: #c0392b;
		color: #fff;
	}

	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 8px;
		gap: 6px;
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.nav-btn {
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		border: none;
		background: #f0f1f3;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.75rem;
		color: #333;
	}

	.nav-btn:hover {
		background: #e2e4e8;
	}

	.nav-label {
		flex: 1;
		border: none;
		background: transparent;
		font-size: 0.95rem;
		font-weight: 600;
		color: #111;
		cursor: pointer;
		border-radius: 4px;
		padding: 4px;
	}

	.nav-label:hover {
		background: #f0f1f3;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 2px;
	}

	.weekday-row {
		flex-shrink: 0;
	}

	.weekday {
		text-align: center;
		font-size: 0.7rem;
		font-weight: 600;
		color: #888;
		padding: 2px 0;
	}

	.weekday.sun {
		color: #d9534f;
	}

	.weekday.sat {
		color: #4a7cd9;
	}

	.days {
		flex: 1;
		min-height: 0;
		grid-auto-rows: 1fr;
	}

	.cell {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 1px;
		border: none;
		background: transparent;
		border-radius: 4px;
		padding: 3px 0 0;
		cursor: default;
		min-height: 0;
		overflow: hidden;
	}

	.cell.has {
		cursor: pointer;
	}

	.cell.has:hover {
		background: #eef2f8;
	}

	.cell-day {
		font-size: 0.78rem;
		color: #333;
		line-height: 1.1;
	}

	.cell.sun .cell-day {
		color: #d9534f;
	}

	.cell.sat .cell-day {
		color: #4a7cd9;
	}

	.cell.out .cell-day {
		color: #c4c8cc;
	}

	.cell.today {
		background: #dce8fb;
	}

	.cell.today .cell-day {
		font-weight: 700;
	}

	.cell-count {
		font-size: 0.6rem;
		font-weight: 600;
		color: #fff;
		background: var(--color-accent, #4a7);
		border-radius: 8px;
		min-width: 14px;
		padding: 0 4px;
		line-height: 1.4;
		text-align: center;
	}

	.cell.out .cell-count {
		opacity: 0.4;
	}
</style>
