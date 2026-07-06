<script lang="ts">
	/**
	 * 달력 위젯 창(데스크탑). 노트가 아니라 위젯 — IndexedDB에 저장되지 않고
	 * 동기화되지 않는다(desktopSession의 sentinel-guid 창일 뿐, pose만 영속).
	 * 본체는 CalendarView(공유). 창이 충분히 크면(폭·높이 임계 초과) 다이어리
	 * 모드로 각 셀에 일정/히스토리 항목을 표기한다. 날짜를 누르면 그날 노트를
	 * 역참조 번들과 같은 떠다니는 창으로 달력 오른쪽에 도킹해 띄운다.
	 */
	import { startPointerDrag } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';
	import CalendarView from './calendar/CalendarView.svelte';
	import DayNotesBundleOverlay from './DayNotesBundleOverlay.svelte';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		CALENDAR_WIDGET_GUID,
		desktopSession
	} from './session.svelte.js';
	import type { CalendarNote } from './calendar/groupNotesByCreateDay.js';

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

	// 다이어리 모드: 창이 넓고+높을 때만. 작으면 개수 배지만 보이는 콤팩트 모드.
	const DIARY_MIN_WIDTH = 460;
	const DIARY_MIN_HEIGHT = 560;
	const diaryMode = $derived(width >= DIARY_MIN_WIDTH && height >= DIARY_MIN_HEIGHT);

	let selectedDate = $state<string | null>(null);
	let selectedNotes = $state<CalendarNote[]>([]);

	function handleDaySelect(date: string, notes: CalendarNote[]) {
		selectedDate = date;
		selectedNotes = notes;
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

	<CalendarView diary={diaryMode} ondayselect={handleDaySelect} />

	<ResizeHandles
		base={() => ({ x, y, width, height })}
		min={{ width: DESKTOP_WINDOW_MIN_WIDTH, height: DESKTOP_WINDOW_MIN_HEIGHT }}
		onresize={(g) => desktopSession.updateGeometry(guid, g)}
	/>
</div>

{#if selectedDate}
	<DayNotesBundleOverlay
		windowed
		date={selectedDate}
		notes={selectedNotes}
		anchor={{ x, y, width, height }}
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
</style>
