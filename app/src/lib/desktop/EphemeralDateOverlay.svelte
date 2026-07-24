<script lang="ts">
	/** 날짜 노트가 아직 없는 날을 눌렀을 때 뜨는 임시 오버레이(req 5).
	 *  이전 년도 같은 날짜 기록을 보여주고(없으면 안내문), "이 날짜 노트 만들기"로
	 *  실제 날짜 노트를 생성해 연다. DayNotesBundleOverlay 의 도킹/드래그/리사이즈
	 *  스켈레톤을 그대로 따른다(portal → --z-modal). */
	import { onMount } from 'svelte';
	import { portal } from '$lib/utils/portal.js';
	import { createNote } from '$lib/core/noteManager.js';
	import { pushToast } from '$lib/stores/toast.js';
	import {
		loadHistoryChain,
		recordsForDate,
		parseDateTitle,
		type HistoryEntry
	} from './calendar/historyChain.js';
	import { loadEventChain, eventsForDate, type EventEntry } from './calendar/eventEntries.js';
	import PrevYearRecords from './calendar/PrevYearRecords.svelte';
	import EventRecords from './calendar/EventRecords.svelte';
	import { startPointerDrag, type Geometry } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';

	interface Props {
		/** YYYY-MM-DD. */
		date: string;
		onclose: () => void;
		/** 만든/여는 노트 제목을 넘긴다(호스트가 openByTitle). */
		onopennote: (title: string) => void;
		anchor?: { x: number; y: number; width: number; height: number };
	}
	let { date, onclose, onopennote, anchor }: Props = $props();

	const WIN_DEFAULT_WIDTH = 340;
	const WIN_DEFAULT_HEIGHT = 360;
	const WIN_MIN = { width: 240, height: 200 };
	const DOCK_GAP = 8;

	let records = $state<HistoryEntry[]>([]);
	let events = $state<EventEntry[]>([]);
	let creating = $state(false);
	let geo = $state<Geometry>({ x: 0, y: 0, width: WIN_DEFAULT_WIDTH, height: WIN_DEFAULT_HEIGHT });

	async function loadRecords() {
		const d = parseDateTitle(date);
		if (!d) {
			records = [];
			events = [];
			return;
		}
		const [chain, evChain] = await Promise.all([loadHistoryChain(), loadEventChain()]);
		records = recordsForDate(chain, d.year, d.month, d.day);
		events = eventsForDate(evChain, d.year, d.month, d.day);
	}

	async function handleCreate() {
		if (creating) return;
		creating = true;
		try {
			await createNote(date); // 날짜 제목 → `년`+일정 시드(noteManager)
			onclose();
			onopennote(date);
		} catch (e) {
			pushToast((e as Error).message ?? '노트를 만들 수 없습니다.', { kind: 'error' });
			creating = false;
		}
	}

	function startTitleDrag(e: PointerEvent) {
		const t = e.target as HTMLElement | null;
		if (t?.closest('[data-no-drag]')) return;
		const origX = geo.x;
		const origY = geo.y;
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				geo = { ...geo, x: Math.max(0, origX + dx), y: Math.max(0, origY + dy) };
			}
		});
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	onMount(() => {
		void loadRecords();
		if (typeof window === 'undefined') return;
		const width = WIN_DEFAULT_WIDTH;
		const height = WIN_DEFAULT_HEIGHT;
		let x: number;
		let y: number;
		if (anchor) {
			x = anchor.x + anchor.width + DOCK_GAP;
			if (x + width > window.innerWidth) {
				const leftX = anchor.x - DOCK_GAP - width;
				x = leftX >= 0 ? leftX : Math.max(0, window.innerWidth - width);
			}
			y = Math.max(0, Math.min(anchor.y, window.innerHeight - height));
		} else {
			x = Math.max(0, Math.round((window.innerWidth - width) / 2));
			y = Math.max(0, Math.round((window.innerHeight - height) / 2));
		}
		geo = { x, y, width, height };
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="ed-overlay"
	use:portal
	style={`left:${geo.x}px; top:${geo.y}px; width:${geo.width}px; height:${geo.height}px;`}
>
	<header class="ed-header" onpointerdown={startTitleDrag}>
		<span class="ed-tag">{date}</span>
		<button type="button" class="ed-close" onclick={onclose} aria-label="닫기" data-no-drag>✕</button>
	</header>

	<div class="ed-body">
		{#if events.length > 0 || records.length > 0}
			<EventRecords records={events} />
			<PrevYearRecords {records} />
		{:else}
			<p class="ed-msg">이 날짜의 이전 년도 기록이 없습니다.</p>
		{/if}
	</div>

	<footer class="ed-foot">
		<button type="button" class="ed-create" onclick={handleCreate} disabled={creating} data-no-drag>
			이 날짜 노트 만들기
		</button>
	</footer>

	<ResizeHandles base={() => geo} min={WIN_MIN} onresize={(g) => (geo = g)} />
</div>

<style>
	.ed-overlay {
		position: fixed;
		z-index: var(--z-modal);
		display: flex;
		flex-direction: column;
		background: var(--color-bg, #fff);
		border: 1px solid var(--color-border, #d4d8dc);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}
	.ed-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border, #e4e8ec);
		background: var(--color-bg-secondary, #f5f6f7);
		cursor: grab;
		user-select: none;
		touch-action: none;
		flex-shrink: 0;
	}
	.ed-tag {
		font-size: 0.78rem;
		font-weight: 700;
		color: #fff;
		background: var(--color-accent, #4a7);
		border-radius: 4px;
		padding: 2px 6px;
	}
	.ed-close {
		width: 30px;
		height: 30px;
		border: none;
		background: none;
		border-radius: 50%;
		font-size: 1rem;
		color: var(--color-text-secondary, #666);
		cursor: pointer;
	}
	.ed-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.ed-msg {
		margin: 0;
		padding: 30px 16px;
		text-align: center;
		color: var(--color-text-secondary, #888);
		font-size: 0.9rem;
	}
	.ed-foot {
		flex-shrink: 0;
		padding: 8px 10px;
		border-top: 1px solid var(--color-border, #e4e8ec);
	}
	.ed-create {
		width: 100%;
		padding: 8px;
		border: 1px solid var(--color-accent, #4a7);
		background: var(--color-accent, #4a7);
		color: #fff;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.ed-create:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
