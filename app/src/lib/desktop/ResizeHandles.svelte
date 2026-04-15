<script lang="ts">
	import { startPointerDrag, applyResize, type Geometry, type ResizeDir } from './dragResize.js';

	interface Props {
		base: () => Geometry;
		min: { width: number; height: number };
		onresize: (g: Geometry) => void;
	}

	let { base, min, onresize }: Props = $props();

	function startResize(e: PointerEvent, dir: ResizeDir) {
		e.stopPropagation();
		const snapshot = { ...base() };
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				onresize(applyResize(snapshot, dir, dx, dy, min));
			}
		});
	}
</script>

<!-- 4 edge handles -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rh rh-n" onpointerdown={(e) => startResize(e, 'n')} aria-hidden="true"></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rh rh-s" onpointerdown={(e) => startResize(e, 's')} aria-hidden="true"></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rh rh-e" onpointerdown={(e) => startResize(e, 'e')} aria-hidden="true"></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rh rh-w" onpointerdown={(e) => startResize(e, 'w')} aria-hidden="true"></div>

<!-- 4 corner handles -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rh rh-nw" onpointerdown={(e) => startResize(e, 'nw')} aria-hidden="true"></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rh rh-ne" onpointerdown={(e) => startResize(e, 'ne')} aria-hidden="true"></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rh rh-sw" onpointerdown={(e) => startResize(e, 'sw')} aria-hidden="true"></div>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rh rh-se" onpointerdown={(e) => startResize(e, 'se')} aria-hidden="true"></div>

<style>
	.rh {
		position: absolute;
		touch-action: none;
		z-index: 10;
	}

	/* Edge handles: 6px thick strips */
	.rh-n { top: 0;    left: 12px; right: 12px; height: 6px; cursor: n-resize; }
	.rh-s { bottom: 0; left: 12px; right: 12px; height: 6px; cursor: s-resize; }
	.rh-e { right: 0;  top: 12px; bottom: 12px; width: 6px;  cursor: e-resize; }
	.rh-w { left: 0;   top: 12px; bottom: 12px; width: 6px;  cursor: w-resize; }

	/* Corner handles: 12×12 squares */
	.rh-nw { top: 0;    left: 0;   width: 12px; height: 12px; cursor: nw-resize; }
	.rh-ne { top: 0;    right: 0;  width: 12px; height: 12px; cursor: ne-resize; }
	.rh-sw { bottom: 0; left: 0;   width: 12px; height: 12px; cursor: sw-resize; }
	.rh-se { bottom: 0; right: 0;  width: 12px; height: 12px; cursor: se-resize; }
</style>
