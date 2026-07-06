<script lang="ts">
	/**
	 * 특정 날짜에 생성된 노트들을 역참조 번들과 동일한 방식으로 묶어 보여주는
	 * 떠다니는 창. `BacklinkBundleOverlay`의 windowed 모드를 본떠, 재사용하는
	 * 실제 심(buildSyntheticBundleSpec + NoteBundleCabinet)은 역참조와 같다.
	 *
	 * 달력 위젯이 소유하는 임시 오버레이 — desktopSession에 등록되지 않으므로
	 * 세션/지오메트리 영속화가 없다(닫으면 소멸). body 로 portal 해 `.note-window`
	 * stacking context 밖 `--z-modal` 밴드에 띄운다.
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
		/** 항목 꺼내기 — 해당 노트를 캔버스 창으로 연다. */
		onopennote: (title: string) => void;
	}

	let { date, notes, onclose, onopennote }: Props = $props();

	const WIN_DEFAULT_WIDTH = 460;
	const WIN_DEFAULT_HEIGHT = 480;
	const WIN_MIN = { width: 280, height: 240 };

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
		if (typeof window !== 'undefined') {
			geo = {
				...geo,
				x: Math.max(0, Math.round((window.innerWidth - geo.width) / 2)),
				y: Math.max(0, Math.round((window.innerHeight - geo.height) / 2))
			};
		}
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
	use:portal
	style={`left:${geo.x}px; top:${geo.y}px; width:${geo.width}px; height:${geo.height}px;`}
>
	<header class="dn-header" onpointerdown={startTitleDrag}>
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

	<ResizeHandles base={() => geo} min={WIN_MIN} onresize={(g) => (geo = g)} />
</div>

<style>
	.dn-overlay {
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

	.dn-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--color-border, #e4e8ec);
		flex-shrink: 0;
		cursor: grab;
		user-select: none;
		touch-action: none;
		background: var(--color-bg-secondary, #f5f6f7);
	}

	.dn-header:active {
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
