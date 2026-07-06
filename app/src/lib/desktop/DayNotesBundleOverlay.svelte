<script lang="ts">
	/**
	 * 특정 날짜에 생성된 노트들을 역참조 번들과 동일한 방식으로 묶어 보여주는 창.
	 * `BacklinkBundleOverlay`처럼 재사용 심(buildSyntheticBundleSpec +
	 * NoteBundleCabinet)은 역참조와 같다. desktopSession에 등록되지 않는 임시
	 * 오버레이 — 세션 영속은 없지만, 창 크기만 localStorage에 로컬로 기억한다.
	 *
	 * 표시 모드:
	 *  - `windowed`(데스크탑): 드래그+리사이즈 떠다니는 창. `anchor`(달력 지오메트리)가
	 *    있으면 달력 오른쪽에 도킹해 연다.
	 *  - 비-windowed(모바일): 풀스크린(inset:0).
	 * 둘 다 body 로 portal 해 `.note-window` stacking context 밖 `--z-modal` 밴드에 띄운다.
	 */
	import { onMount } from 'svelte';
	import { portal } from '$lib/utils/portal.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import NoteBundleCabinet from '$lib/editor/noteBundle/NoteBundleCabinet.svelte';
	import { buildSyntheticBundleSpec, type BundleSpec } from '$lib/editor/noteBundle/index.js';
	import { startPointerDrag, type Geometry } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';
	import type { CalendarNote } from './calendar/groupNotesByCreateDay.js';

	interface Props {
		/** YYYY-MM-DD — 헤더에 표시. */
		date: string;
		/** 그날 생성된 노트들(달력이 이미 계산). */
		notes: CalendarNote[];
		onclose: () => void;
		/** 항목 꺼내기 — 해당 노트를 연다. */
		onopennote: (title: string) => void;
		/** true 면 드래그/리사이즈 떠다니는 창(데스크탑), false 면 풀스크린(모바일). */
		windowed?: boolean;
		/** windowed 일 때 이 사각형(달력 창) 오른쪽에 도킹해 연다. */
		anchor?: { x: number; y: number; width: number; height: number };
	}

	let { date, notes, onclose, onopennote, windowed = true, anchor }: Props = $props();

	const WIN_DEFAULT_WIDTH = 460;
	const WIN_DEFAULT_HEIGHT = 480;
	const WIN_MIN = { width: 280, height: 240 };
	const DOCK_GAP = 8;
	const SIZE_KEY = 'calendar:daynotes:size';

	const titles = $derived(notes.map((n) => n.title.trim()).filter(Boolean));
	const count = $derived(titles.length);
	const spec = $derived<BundleSpec | null>(
		titles.length > 0 ? buildSyntheticBundleSpec(titles, 'bundle') : null
	);

	let geo = $state<Geometry>({
		x: 0,
		y: 0,
		width: WIN_DEFAULT_WIDTH,
		height: WIN_DEFAULT_HEIGHT
	});

	function loadStoredSize(): { width: number; height: number } | null {
		if (typeof localStorage === 'undefined') return null;
		try {
			const raw = localStorage.getItem(SIZE_KEY);
			if (!raw) return null;
			const o = JSON.parse(raw);
			if (typeof o?.width === 'number' && typeof o?.height === 'number') {
				return { width: o.width, height: o.height };
			}
		} catch {
			/* ignore */
		}
		return null;
	}
	function saveSize(width: number, height: number): void {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(SIZE_KEY, JSON.stringify({ width: Math.round(width), height: Math.round(height) }));
		} catch {
			/* ignore */
		}
	}

	function onResize(g: Geometry) {
		geo = g;
		saveSize(g.width, g.height);
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

	onMount(() => {
		if (!windowed || typeof window === 'undefined') return;
		const stored = loadStoredSize();
		const width = Math.max(WIN_MIN.width, stored?.width ?? WIN_DEFAULT_WIDTH);
		const height = Math.max(WIN_MIN.height, stored?.height ?? WIN_DEFAULT_HEIGHT);
		let x: number;
		let y: number;
		if (anchor) {
			// 달력 오른쪽에 도킹; 넘치면 왼쪽, 그래도 안 되면 뷰포트에 클램프.
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

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	function eject(target: string) {
		onclose();
		onopennote(target);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="dn-overlay"
	class:windowed
	use:portal
	style={windowed
		? `left:${geo.x}px; top:${geo.y}px; width:${geo.width}px; height:${geo.height}px;`
		: ''}
>
	<header class="dn-header" onpointerdown={windowed ? startTitleDrag : undefined}>
		<div class="dn-title">
			<span class="dn-tag">{date}</span>
			<span class="dn-count">{count}개</span>
		</div>
		<button type="button" class="dn-close" onclick={onclose} aria-label="닫기" data-no-drag>✕</button>
	</header>

	<div class="dn-body">
		{#if !spec || count === 0}
			<p class="dn-msg">이 날 생성된 노트가 없습니다.</p>
		{:else}
			<NoteBundleCabinet
				{spec}
				view={null}
				hostGuid={null}
				variant="dedicated"
				EditorComponent={TomboyEditor}
				oninternallink={eject}
			/>
		{/if}
	</div>

	{#if windowed}
		<ResizeHandles base={() => geo} min={WIN_MIN} onresize={onResize} />
	{/if}
</div>

<style>
	.dn-overlay {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		display: flex;
		flex-direction: column;
		background: var(--color-bg, #fff);
	}

	.dn-overlay.windowed {
		inset: auto;
		border: 1px solid var(--color-border, #d4d8dc);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}

	.dn-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px calc(10px) max(14px, env(safe-area-inset-left));
		border-bottom: 1px solid var(--color-border, #e4e8ec);
		flex-shrink: 0;
		background: var(--color-bg-secondary, #f5f6f7);
	}

	.dn-overlay.windowed .dn-header {
		cursor: grab;
		user-select: none;
		touch-action: none;
	}

	.dn-overlay.windowed .dn-header:active {
		cursor: grabbing;
	}

	.dn-title {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.dn-tag {
		flex-shrink: 0;
		font-size: 0.78rem;
		font-weight: 700;
		color: #fff;
		background: var(--color-accent, #4a7);
		border-radius: 4px;
		padding: 2px 6px;
	}

	.dn-count {
		flex-shrink: 0;
		font-size: 0.78rem;
		color: var(--color-text-secondary, #888);
	}

	.dn-close {
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		border: none;
		background: none;
		border-radius: 50%;
		font-size: 1rem;
		color: var(--color-text-secondary, #666);
		cursor: pointer;
	}

	.dn-close:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.dn-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.dn-msg {
		margin: 0;
		padding: 40px 20px;
		text-align: center;
		color: var(--color-text-secondary, #888);
		font-size: 0.95rem;
	}
</style>
