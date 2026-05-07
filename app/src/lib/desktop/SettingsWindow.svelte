<script lang="ts">
	import { startPointerDrag } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		SETTINGS_WINDOW_GUID,
		desktopSession
	} from './session.svelte.js';

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
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="settings-window"
	class:hidden={!active}
	style="left:{x}px; top:{y}px; width:{width}px; height:{height}px; z-index:{z};"
	onpointerdowncapture={handleFocus}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="title-bar" onpointerdown={startDrag} onauxclick={handleTitleBarAuxClick}>
		<span class="title-text">설정</span>
		<button
			type="button"
			class="pin-btn"
			class:pinned
			onclick={handlePinToggle}
			aria-label={pinned ? '항상 위 해제' : '항상 위'}
			title={pinned ? '항상 위 해제' : '항상 위'}
			data-no-drag
		>&#x1F4CC;</button>
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

	<ResizeHandles
		base={() => ({ x, y, width, height })}
		min={{ width: DESKTOP_WINDOW_MIN_WIDTH, height: DESKTOP_WINDOW_MIN_HEIGHT }}
		onresize={(g) => desktopSession.updateGeometry(guid, g)}
	/>
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

	.settings-window.hidden {
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

	.pin-btn {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		color: #888;
		font-size: 0.75rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 3px;
		opacity: 0.5;
	}

	.pin-btn:hover,
	.pin-btn.pinned {
		opacity: 1;
		background: rgba(255, 255, 255, 0.15);
		color: #fff;
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
</style>
