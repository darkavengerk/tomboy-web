<script lang="ts">
	import { startPointerDrag } from './dragResize.js';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		SETTINGS_WINDOW_GUID
	} from './session.svelte.js';

	interface Props {
		x: number;
		y: number;
		width: number;
		height: number;
		z: number;
		onfocus: (guid: string) => void;
		onclose: (guid: string) => void;
		onmove: (guid: string, x: number, y: number) => void;
		onresize: (guid: string, width: number, height: number) => void;
	}

	let { x, y, width, height, z, onfocus, onclose, onmove, onresize }: Props = $props();

	const guid = SETTINGS_WINDOW_GUID;

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

	function startResize(e: PointerEvent) {
		e.stopPropagation();
		onfocus(guid);
		const origW = width;
		const origH = height;
		startPointerDrag(e, {
			onMove: (dx, dy) =>
				onresize(
					guid,
					Math.max(DESKTOP_WINDOW_MIN_WIDTH, origW + dx),
					Math.max(DESKTOP_WINDOW_MIN_HEIGHT, origH + dy)
				)
		});
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="settings-window"
	style="left:{x}px; top:{y}px; width:{width}px; height:{height}px; z-index:{z};"
	onpointerdowncapture={handleFocus}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="title-bar" onpointerdown={startDrag}>
		<span class="title-text">설정</span>
		<button
			type="button"
			class="close-btn"
			onclick={handleClose}
			aria-label="창 닫기"
			data-no-drag
		>✕</button>
	</div>

	<div class="body">
		<iframe src="/settings?embed=1" title="설정"></iframe>
	</div>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="resize-grip" onpointerdown={startResize} aria-hidden="true"></div>
</div>

<style>
	.settings-window {
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

	.close-btn {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		color: #ccc;
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 3px;
	}

	.close-btn:hover {
		background: #c0392b;
		color: #fff;
	}

	.body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.body iframe {
		width: 100%;
		height: 100%;
		border: 0;
		display: block;
	}

	.resize-grip {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 16px;
		height: 16px;
		cursor: nwse-resize;
		touch-action: none;
		background:
			linear-gradient(
				135deg,
				transparent 0%,
				transparent 50%,
				#888 50%,
				#888 55%,
				transparent 55%,
				transparent 65%,
				#888 65%,
				#888 70%,
				transparent 70%,
				transparent 80%,
				#888 80%,
				#888 85%,
				transparent 85%
			);
	}
</style>
