<script lang="ts">
	import NoteWindow from './NoteWindow.svelte';
	import { desktopSession, DESKTOP_PINNED_Z } from './session.svelte.js';
	import { startPointerDrag } from './dragResize.js';

	interface Props {
		index: number;
		/** 'top' = F2 (drops down from the top edge, width + height resizable);
		 *  'right' = F3 (slides in from the right edge, width only). */
		side: 'top' | 'right';
	}
	let { index, side }: Props = $props();

	const open = $derived(desktopSession.isDrawerOpen(index));
	const width = $derived(desktopSession.getDrawerWidth(index));
	const height = $derived(desktopSession.getDrawerHeight(index));
	const left = $derived(desktopSession.getDrawerLeft(index));
	const windows = $derived(desktopSession.drawerWindows(index));
	const surface = $derived({ kind: 'drawer' as const, index });

	function startWidthDrag(e: PointerEvent) {
		const base = width;
		// Top drawer's right-edge grip grows it (+dx); right drawer's left-edge
		// grip grows it as the pointer moves left (−dx).
		startPointerDrag(e, {
			onMove: (dx) => {
				const next = side === 'right' ? base - dx : base + dx;
				desktopSession.setDrawerWidth(index, next);
			}
		});
	}

	function startHeightDrag(e: PointerEvent) {
		const base = height;
		// Top drawer's bottom-edge grip grows its height (+dy).
		startPointerDrag(e, {
			onMove: (_dx, dy) => desktopSession.setDrawerHeight(index, base + dy)
		});
	}

	function startLeftDrag(e: PointerEvent) {
		// Top drawer's left-edge grip: resize-from-left (right edge pinned). The
		// offset is floored above 0 by the session so it clears the rail handle.
		const base = left;
		startPointerDrag(e, {
			onMove: (dx) => desktopSession.setDrawerLeftKeepRight(index, base + dx)
		});
	}
</script>

<!-- Always mounted so drawer notes (terminal WS, editors) stay alive when the
     panel is tucked off-screen. Hidden via transform (NOT display:none) so the
     layout/size persists — terminals keep their geometry. -->
<div
	class="drawer"
	class:open
	data-side={side}
	style="--drawer-width: {width}px; --drawer-height: {height}px; --drawer-left: {left}px;"
	aria-hidden={!open}
>
	<div class="drawer-windows">
		{#each windows as win (win.guid)}
			<NoteWindow
				guid={win.guid}
				x={win.x}
				y={win.y}
				width={win.width}
				height={win.height}
				z={(win.pinned ? DESKTOP_PINNED_Z : 0) + win.z}
				pinned={win.pinned}
				active={open}
				hidden={false}
				minimized={win.minimized}
				{surface}
				onfocus={(g) => desktopSession.focusWindowOn(surface, g)}
				onclose={(g) => void desktopSession.closeWindowOn(surface, g)}
				onmove={(g, x, y) => desktopSession.moveWindowOn(surface, g, x, y)}
				onresize={(g, w, h) =>
					desktopSession.updateGeometryOn(surface, g, { x: win.x, y: win.y, width: w, height: h })}
				onopenlink={(t) => void desktopSession.openByTitle(t)}
			/>
		{/each}
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="width-grip" data-side={side} onpointerdown={startWidthDrag} title="서랍 폭 조절"></div>
	{#if side === 'top'}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="left-grip" onpointerdown={startLeftDrag} title="서랍 왼쪽 가장자리 조절"></div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="height-grip" onpointerdown={startHeightDrag} title="서랍 높이 조절"></div>
	{/if}
</div>

<style>
	.drawer {
		position: fixed;
		background: rgba(18, 18, 18, 0.96);
		box-shadow: 0 0 24px rgba(0, 0, 0, 0.5);
		z-index: var(--z-drawer);
		transition: transform 0.18s ease;
		overflow: hidden;
	}
	/* Top drawer (F2) — anchored to the top-left of the canvas (right of the
	   rail). Both width and height are user-set; it drops down when open. */
	.drawer[data-side='top'] {
		left: calc(var(--rail-width, 80px) + var(--drawer-left, 100px));
		top: 0;
		width: var(--drawer-width, 760px);
		height: var(--drawer-height, 380px);
		transform: translateY(-110%);
	}
	/* Right drawer (F3) — full height, width-resizable, slides in from the right. */
	.drawer[data-side='right'] {
		right: 0;
		top: 0;
		bottom: 0;
		width: var(--drawer-width, 480px);
		transform: translateX(110%);
	}
	.drawer.open {
		transform: translate(0, 0);
	}
	.drawer-windows {
		position: absolute;
		inset: 0;
	}
	/* Grips sit above every in-drawer window (even pinned ones, z up to
	   DESKTOP_PINNED_Z + nextZ) so they stay grabbable. Contained within the
	   drawer's own stacking context, so this large value never leaks out. */
	.width-grip,
	.left-grip,
	.height-grip {
		position: absolute;
		z-index: 2000001;
	}
	.width-grip,
	.left-grip {
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: ew-resize;
	}
	.width-grip[data-side='right'] {
		left: 0;
	}
	/* Top drawer's width grip lives on its right edge, left grip on its left. */
	.width-grip[data-side='top'] {
		right: 0;
	}
	.left-grip {
		left: 0;
	}
	.height-grip {
		left: 0;
		right: 0;
		bottom: 0;
		height: 6px;
		cursor: ns-resize;
	}
</style>
