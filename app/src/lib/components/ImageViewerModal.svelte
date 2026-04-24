<script lang="ts">
	import { onMount } from 'svelte';
	import { imageViewer } from '$lib/stores/imageViewer.svelte.js';
	import { startPointerDrag, type Geometry } from '$lib/desktop/dragResize.js';
	import ResizeHandles from '$lib/desktop/ResizeHandles.svelte';
	import { portal } from '$lib/utils/portal.js';

	const src = $derived(imageViewer.src);

	let frame = $state<Geometry | null>(null);
	let natural = $state<{ w: number; h: number } | null>(null);

	const INITIAL_MARGIN = 16;
	const MIN_SIZE = 64;
	// Zoom caps expressed in viewport units so the limits behave the same
	// regardless of natural-size. A natural-scale cap would clamp tiny
	// icons back below the initial fullscreen fit, shrinking them on any
	// wheel tick — see git history.
	const MAX_FRAME_VIEWPORT_FACTOR = 10;
	const MIN_SCALE = 0.05;

	function viewport(): { w: number; h: number } {
		return {
			w: window.innerWidth || document.documentElement.clientWidth || 1,
			h: window.innerHeight || document.documentElement.clientHeight || 1
		};
	}

	function clampedFrame(g: Geometry): Geometry {
		if (!natural) return g;
		const vp = viewport();
		const maxW = vp.w * MAX_FRAME_VIEWPORT_FACTOR;
		const maxH = vp.h * MAX_FRAME_VIEWPORT_FACTOR;
		const minW = Math.max(MIN_SIZE, natural.w * MIN_SCALE);
		const minH = Math.max(MIN_SIZE, natural.h * MIN_SCALE);
		let { x, y, width, height } = g;
		width = Math.min(maxW, Math.max(minW, width));
		height = Math.min(maxH, Math.max(minH, height));
		// Keep at least a sliver on screen so the frame can't be lost.
		x = Math.min(vp.w - 40, Math.max(40 - width, x));
		y = Math.min(vp.h - 40, Math.max(40 - height, y));
		return { x, y, width, height };
	}

	function fitInitial(w: number, h: number): Geometry {
		const vp = viewport();
		const maxW = Math.max(MIN_SIZE, vp.w - INITIAL_MARGIN * 2);
		const maxH = Math.max(MIN_SIZE, vp.h - INITIAL_MARGIN * 2);
		// Fill the viewport as much as possible while preserving aspect ratio
		// — uniformly scale (up OR down) until one axis touches the cap.
		const ratio = Math.min(maxW / w, maxH / h);
		const width = Math.max(MIN_SIZE, w * ratio);
		const height = Math.max(MIN_SIZE, h * ratio);
		return {
			x: (vp.w - width) / 2,
			y: (vp.h - height) / 2,
			width,
			height
		};
	}

	// Measure the image off-DOM so we can compute the initial frame BEFORE
	// rendering the visible <img>. The load event is flaky on reused <img>
	// elements when the browser serves from cache, so we use a fresh Image.
	$effect(() => {
		const s = src;
		frame = null;
		natural = null;
		if (s === null) return;
		const img = new Image();
		let cancelled = false;
		img.onload = () => {
			if (cancelled) return;
			const w = img.naturalWidth || 1;
			const h = img.naturalHeight || 1;
			natural = { w, h };
			frame = fitInitial(w, h);
		};
		img.onerror = () => {
			if (cancelled) return;
			// Best-effort fallback: size the frame to a square cap so the
			// user still sees the broken-image icon at a sensible size.
			const vp = viewport();
			const side = Math.min(vp.w, vp.h) - INITIAL_MARGIN * 2;
			natural = { w: side, h: side };
			frame = fitInitial(side, side);
		};
		img.src = s;
		return () => {
			cancelled = true;
		};
	});

	function close() {
		imageViewer.close();
	}

	function onKeyDown(e: KeyboardEvent) {
		if (src === null) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}

	onMount(() => {
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	});

	// --- Wheel zoom around the pointer ---
	function onWheel(e: WheelEvent) {
		if (!frame || !natural) return;
		e.preventDefault();
		const base = frame;
		const factor = Math.exp(-e.deltaY * 0.0015);
		scaleAround(base, factor, e.clientX, e.clientY);
	}

	function scaleAround(base: Geometry, factor: number, cx: number, cy: number) {
		if (!natural) return;
		const newW = base.width * factor;
		const newH = base.height * factor;
		// Anchor the point under (cx,cy) so it stays put while scaling.
		const ratioX = (cx - base.x) / base.width;
		const ratioY = (cy - base.y) / base.height;
		const next: Geometry = {
			x: cx - ratioX * newW,
			y: cy - ratioY * newH,
			width: newW,
			height: newH
		};
		frame = clampedFrame(next);
	}

	// --- Touch pinch zoom ---
	let pinch: { d0: number; fx: number; fy: number; base: Geometry } | null = null;

	function distance(t1: Touch, t2: Touch): number {
		const dx = t1.clientX - t2.clientX;
		const dy = t1.clientY - t2.clientY;
		return Math.hypot(dx, dy);
	}

	function midpoint(t1: Touch, t2: Touch): { x: number; y: number } {
		return {
			x: (t1.clientX + t2.clientX) / 2,
			y: (t1.clientY + t2.clientY) / 2
		};
	}

	function onTouchStart(e: TouchEvent) {
		if (!frame || e.touches.length !== 2) return;
		e.preventDefault();
		// A pan may already be in progress on the first finger. Abort it so
		// the stale drag doesn't fight the pinch until the user lifts.
		panCancelled = true;
		const [t1, t2] = [e.touches[0], e.touches[1]];
		const mid = midpoint(t1, t2);
		pinch = {
			d0: distance(t1, t2),
			fx: mid.x,
			fy: mid.y,
			base: { ...frame }
		};
	}

	function onTouchMove(e: TouchEvent) {
		if (!pinch || e.touches.length !== 2) return;
		e.preventDefault();
		const d = distance(e.touches[0], e.touches[1]);
		const factor = d / Math.max(1, pinch.d0);
		scaleAround(pinch.base, factor, pinch.fx, pinch.fy);
	}

	function onTouchEnd(e: TouchEvent) {
		if (e.touches.length < 2) pinch = null;
	}

	// --- Drag to pan ---
	// Clicking-and-dragging the frame moves the whole image. If a pinch
	// gesture kicks in mid-drag (second finger lands), we flip the
	// cancelled flag so further pan moves are ignored until the user
	// lifts and re-presses. Without this the pan's stale baseFrame would
	// fight the pinch's scaleAround.
	let panCancelled = $state(false);

	function startPan(e: PointerEvent) {
		if (!frame) return;
		if (e.pointerType === 'touch' && pinch) return;
		// Non-primary mouse buttons shouldn't pan.
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		e.stopPropagation();
		panCancelled = false;
		const baseFrame = { ...frame };
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				if (panCancelled) return;
				frame = clampedFrame({
					x: baseFrame.x + dx,
					y: baseFrame.y + dy,
					width: baseFrame.width,
					height: baseFrame.height
				});
			}
		});
	}

	function onBackdropPointerDown(e: PointerEvent) {
		if (e.target === e.currentTarget) close();
	}
</script>

{#if src}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		use:portal
		class="image-viewer-backdrop"
		role="dialog"
		aria-modal="true"
		aria-label="이미지 보기"
		onpointerdown={onBackdropPointerDown}
	>
		{#if frame}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="viewer-frame"
				style:left="{frame.x}px"
				style:top="{frame.y}px"
				style:width="{frame.width}px"
				style:height="{frame.height}px"
				onwheel={onWheel}
				ontouchstart={onTouchStart}
				ontouchmove={onTouchMove}
				ontouchend={onTouchEnd}
				ontouchcancel={onTouchEnd}
				onpointerdown={startPan}
			>
				<img class="viewer-image" {src} alt="" draggable="false" />
				<ResizeHandles
					base={() => frame!}
					min={{ width: MIN_SIZE, height: MIN_SIZE }}
					onresize={(g) => (frame = clampedFrame(g))}
				/>
				<button
					class="viewer-close"
					onclick={close}
					onpointerdown={(e) => e.stopPropagation()}
					aria-label="닫기"
				>
					✕
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.image-viewer-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.72);
		z-index: 2000;
		overflow: hidden;
		touch-action: none;
	}

	.viewer-frame {
		position: absolute;
		background: #000;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
		border: 2px solid rgba(255, 255, 255, 0.35);
		border-radius: 4px;
		overflow: visible;
		user-select: none;
		touch-action: none;
		cursor: grab;
	}

	.viewer-frame:active {
		cursor: grabbing;
	}

	.viewer-frame:hover {
		border-color: rgba(255, 255, 255, 0.6);
	}

	.viewer-image {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		pointer-events: none;
		-webkit-user-drag: none;
	}

	.viewer-close {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 32px;
		height: 32px;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.55);
		color: #fff;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		z-index: 20;
	}

	.viewer-close:hover {
		background: rgba(0, 0, 0, 0.8);
	}
</style>
