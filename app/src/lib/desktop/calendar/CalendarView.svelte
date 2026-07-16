<script lang="ts">
	/**
	 * 달력 본체(창 크롬 없음) — 데스크탑 창(CalendarWindow)과 모바일 라우트
	 * (/calendar)가 공유한다. 월별 그리드 + 연·월 네비 + 날짜별 생성 노트 개수
	 * 배지를 그리고, `diary`가 켜지면 각 셀에 그날의 일정+히스토리 항목을
	 * 다이어리처럼 표기한다. 날짜 선택은 `ondayselect`로 호스트에 위임한다
	 * (데스크탑=오른쪽 도킹 창, 모바일=풀스크린).
	 */
	import { onMount } from 'svelte';
	import { listNotes } from '$lib/core/noteManager.js';
	import { onInvalidate } from '$lib/stores/noteListCache.js';
	import {
		groupNotesByCreateDay,
		localDayKey,
		type CalendarNote
	} from './groupNotesByCreateDay.js';
	import { buildMonthCells, type MonthCell } from './monthGrid.js';
	import { loadDiaryDayMap, type DiaryEntry } from './diaryEntries.js';
	import { loadHistoryChain, recordsForDate, type HistoryChain } from './historyChain.js';

	interface Props {
		/** 다이어리 모드(셀에 일정/히스토리 항목 표기). */
		diary?: boolean;
		/** 셀 본문 클릭 — 그날 날짜 노트(제목 YYYY-MM-DD)를 연다. */
		onopendate?: (date: string) => void;
		/** 개수 배지 클릭 — 그날 생성된 노트 목록을 넘긴다. */
		ondayselect: (date: string, notes: CalendarNote[]) => void;
	}

	let { diary = false, onopendate, ondayselect }: Props = $props();

	const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
	const MAX_ENTRY_LINES = 3;

	let notes = $state<CalendarNote[]>([]);
	const dayMap = $derived(groupNotesByCreateDay(notes));

	const today = new Date();
	const todayKey = localDayKey(today);
	let viewYear = $state(today.getFullYear());
	let viewMonth = $state(today.getMonth()); // 0-based

	const cells = $derived(buildMonthCells(viewYear, viewMonth, todayKey, dayMap));

	// --- diary data (schedule + history entries, keyed by day-of-month) ---
	let diaryMap = $state<Map<number, DiaryEntry[]>>(new Map());
	let diaryToken = 0;
	async function loadDiary() {
		if (!diary) {
			diaryMap = new Map();
			return;
		}
		const token = ++diaryToken;
		const m = await loadDiaryDayMap(viewYear, viewMonth);
		if (token === diaryToken) diaryMap = m;
	}
	$effect(() => {
		// deps: diary, viewYear, viewMonth (read synchronously inside loadDiary)
		void loadDiary();
	});

	let historyChain = $state<HistoryChain | null>(null);
	async function loadHistory() {
		historyChain = await loadHistoryChain();
	}

	function prevYearsFor(cell: MonthCell) {
		if (!diary || !cell.inMonth || !historyChain) return [];
		return recordsForDate(historyChain, viewYear, cell.date.getMonth() + 1, cell.day);
	}

	async function loadNotes() {
		const all = await listNotes();
		notes = all.map((n) => ({ guid: n.guid, title: n.title, createDate: n.createDate }));
	}

	onMount(() => {
		void loadNotes();
		void loadHistory();
		// 어떤 노트든 생성/삭제/변경으로 목록 캐시가 무효화되면 개수 + 다이어리 + 히스토리 갱신.
		return onInvalidate(() => {
			void loadNotes();
			void loadDiary();
			void loadHistory();
		});
	});

	function pad(n: number): string {
		return String(n).padStart(2, '0');
	}
	function fmtTime(t: { h: number; m: number }): string {
		return `${pad(t.h)}:${pad(t.m)}`;
	}
	function entriesFor(cell: MonthCell): DiaryEntry[] {
		return cell.inMonth ? (diaryMap.get(cell.day) ?? []) : [];
	}

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
		if (!cell.inMonth) {
			viewYear = cell.date.getFullYear();
			viewMonth = cell.date.getMonth();
			return;
		}
		if (onopendate) {
			onopendate(cell.key);
			return;
		}
		// onopendate 미제공(모바일 /calendar 등) — 기존 동작 유지: 개수>0면 목록.
		if (cell.count > 0) ondayselect(cell.key, dayMap.get(cell.key) ?? []);
	}
	function clickBadge(e: MouseEvent, cell: MonthCell) {
		e.stopPropagation();
		ondayselect(cell.key, dayMap.get(cell.key) ?? []);
	}
	function cellKeydown(e: KeyboardEvent, cell: MonthCell) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			clickCell(cell);
		}
	}
</script>

<div class="cal-view" class:diary>
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
			{@const entries = entriesFor(cell)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="cell"
				role="button"
				tabindex="0"
				class:out={!cell.inMonth}
				class:today={cell.isToday}
				class:has={cell.count > 0}
				class:sun={cell.date.getDay() === 0}
				class:sat={cell.date.getDay() === 6}
				onclick={() => clickCell(cell)}
				onkeydown={(e) => cellKeydown(e, cell)}
				data-no-drag
			>
				<span class="cell-day">{cell.day}</span>
				{#if cell.count > 0}
					<button
						type="button"
						class="cell-count"
						onclick={(e) => clickBadge(e, cell)}
						aria-label="{cell.key} 노트 목록"
						title="이 날의 노트 목록"
						data-no-drag>{cell.count}</button
					>
				{/if}
				{#if diary && entries.length > 0}
					<span class="cell-entries">
						{#each entries.slice(0, MAX_ENTRY_LINES) as e, i (i)}
							<span class="cell-entry" class:hist={e.source === 'history'}>
								{#if e.time}<b>{fmtTime(e.time)}</b> {/if}{e.label}
							</span>
						{/each}
						{#if entries.length > MAX_ENTRY_LINES}
							<span class="cell-more">+{entries.length - MAX_ENTRY_LINES}</span>
						{/if}
					</span>
				{/if}
				{#if diary}
					{@const pys = prevYearsFor(cell)}
					{#if pys.length > 0}
						<span class="cell-prev">
							{#each pys.slice(0, 2) as p, i (i)}
								<span class="cell-prev-line"><b>{p.year}</b> {p.label}</span>
							{/each}
							{#if pys.length > 2}
								<span class="cell-prev-more">+{pys.length - 2}</span>
							{/if}
						</span>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.cal-view {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 8px;
		gap: 6px;
		/* 창(노트) 크기에 비례해 폰트가 커지도록 컨테이너 쿼리 기준. 하위
		   폰트들은 clamp(min, Ncqi, max) — cqi = 이 컨테이너 폭의 1%. */
		container-type: inline-size;
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
		font-size: clamp(0.72rem, 2.6cqi, 1.2rem);
		color: #333;
	}

	.nav-btn:hover {
		background: #e2e4e8;
	}

	.nav-label {
		flex: 1;
		border: none;
		background: transparent;
		font-size: clamp(0.92rem, 3.6cqi, 1.55rem);
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
		font-size: clamp(0.7rem, 2.6cqi, 1.15rem);
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
		align-items: stretch;
		gap: 1px;
		border: none;
		background: transparent;
		border-radius: 4px;
		padding: 3px 2px 1px;
		cursor: default;
		min-height: 0;
		overflow: hidden;
		text-align: left;
	}

	.cell.has {
		cursor: pointer;
	}
	.cell.has:hover {
		background: #eef2f8;
	}

	.cell-day {
		font-size: clamp(0.8rem, 3cqi, 1.35rem);
		color: #333;
		line-height: 1.1;
		align-self: center;
	}

	.diary .cell-day {
		align-self: flex-start;
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
		position: absolute;
		top: 2px;
		right: 2px;
		font-size: clamp(0.58rem, 2.1cqi, 0.9rem);
		font-weight: 600;
		color: #fff;
		background: var(--color-accent, #4a7);
		border-radius: 8px;
		min-width: 13px;
		padding: 0 3px;
		line-height: 1.4;
		text-align: center;
	}

	.cell.out .cell-count {
		opacity: 0.4;
	}

	.cell-entries {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-height: 0;
		overflow: hidden;
	}

	.cell-entry {
		font-size: clamp(0.6rem, 2.2cqi, 0.95rem);
		line-height: 1.25;
		color: #2a2a2a;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		background: #eef4ea;
		border-radius: 3px;
		padding: 0 3px;
	}

	.cell-entry.hist {
		background: #eef0f6;
		color: #444;
	}

	.cell-entry b {
		font-weight: 700;
	}

	.cell-more {
		font-size: clamp(0.55rem, 2cqi, 0.85rem);
		color: #888;
		padding-left: 3px;
	}

	.cell-count {
		border: none;
		cursor: pointer;
	}
	.cell-count:hover {
		filter: brightness(1.1);
	}

	.cell-prev {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-height: 0;
		overflow: hidden;
		text-align: right;
		margin-top: auto;
	}
	.cell-prev-line {
		font-size: clamp(0.55rem, 2cqi, 0.85rem);
		line-height: 1.2;
		color: #7c828a;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cell-prev-line b {
		font-weight: 700;
		color: #565c63;
	}
	.cell-prev-more {
		font-size: clamp(0.52rem, 1.9cqi, 0.8rem);
		color: #7c828a;
		text-align: right;
	}
</style>
