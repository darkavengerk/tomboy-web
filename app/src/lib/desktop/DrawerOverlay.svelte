<script lang="ts">
	import NoteWindow from './NoteWindow.svelte';
	import { desktopSession, DESKTOP_PINNED_Z } from './session.svelte.js';
	import { startPointerDrag } from './dragResize.js';

	interface Props {
		index: number;
		side: 'left' | 'right';
	}
	let { index, side }: Props = $props();

	const open = $derived(desktopSession.isDrawerOpen(index));
	const width = $derived(desktopSession.getDrawerWidth(index));
	const windows = $derived(desktopSession.drawerWindows(index));
	const surface = $derived({ kind: 'drawer' as const, index });

	function startWidthDrag(e: PointerEvent) {
		const base = width;
		// Left drawer grows when its right-edge grip moves right (+dx); right
		// drawer grows when its left-edge grip moves left (−dx).
		startPointerDrag(e, {
			onMove: (dx) => {
				const next = side === 'left' ? base + dx : base - dx;
				desktopSession.setDrawerWidth(index, next);
			}
		});
	}
</script>

<!-- Always mounted so drawer notes (terminal WS, editors) stay alive when the
     panel is tucked off-screen. Hidden via transform (NOT display:none) so the
     layout/size persists — terminals keep their geometry. -->
<div class="drawer" class:open data-side={side} style="--drawer-width: {width}px;" aria-hidden={!open}>
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
</div>

<style>
	.drawer {
		position: fixed;
		top: 0;
		bottom: 0;
		width: var(--drawer-width, 480px);
		background: rgba(18, 18, 18, 0.96);
		box-shadow: 0 0 24px rgba(0, 0, 0, 0.5);
		z-index: var(--z-drawer);
		transition: transform 0.18s ease;
		overflow: hidden;
	}
	.drawer[data-side='left'] {
		left: var(--rail-width, 80px);
		transform: translateX(-110%);
	}
	.drawer[data-side='right'] {
		right: 0;
		transform: translateX(110%);
	}
	.drawer.open {
		transform: translateX(0);
	}
	.drawer-windows {
		position: absolute;
		inset: 0;
	}
	.width-grip {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: ew-resize;
		z-index: 2;
	}
	.width-grip[data-side='left'] {
		right: 0;
	}
	.width-grip[data-side='right'] {
		left: 0;
	}
</style>
