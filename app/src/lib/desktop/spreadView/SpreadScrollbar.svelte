<script lang="ts">
	/**
	 * Big custom vertical scrollbar bound to an external scroll container.
	 * Drives the gallery (page) scroll for 펼쳐보기. A custom widget (not a
	 * styled native scrollbar) so the "big" thumb renders identically in
	 * Firefox, which can't widen `::-webkit-scrollbar`.
	 */
	interface Props {
		target: HTMLElement | null;
	}
	let { target }: Props = $props();

	let trackEl: HTMLDivElement | undefined;
	let scrollTop = $state(0);
	let scrollHeight = $state(0);
	let clientHeight = $state(0);

	function sync() {
		if (!target) return;
		scrollTop = target.scrollTop;
		scrollHeight = target.scrollHeight;
		clientHeight = target.clientHeight;
	}

	$effect(() => {
		const el = target;
		if (!el) return;
		sync();
		el.addEventListener('scroll', sync, { passive: true });
		const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
		ro?.observe(el);
		return () => {
			el.removeEventListener('scroll', sync);
			ro?.disconnect();
		};
	});

	const scrollable = $derived(scrollHeight > clientHeight + 1);
	const thumbHeightPct = $derived(
		scrollable ? Math.max(8, (clientHeight / scrollHeight) * 100) : 100
	);
	const maxScroll = $derived(Math.max(1, scrollHeight - clientHeight));
	const thumbTopPct = $derived(
		scrollable ? (scrollTop / maxScroll) * (100 - thumbHeightPct) : 0
	);

	let dragging = false;
	let dragStartY = 0;
	let dragStartScroll = 0;

	function onThumbPointerDown(e: PointerEvent) {
		if (!target) return;
		e.preventDefault();
		e.stopPropagation();
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			/* test env / unsupported — drag still works */
		}
		dragging = true;
		dragStartY = e.clientY;
		dragStartScroll = target.scrollTop;
	}
	function onThumbPointerMove(e: PointerEvent) {
		if (!dragging || !target || !trackEl) return;
		const trackH = trackEl.clientHeight;
		const thumbPx = trackH * (thumbHeightPct / 100);
		const travel = Math.max(1, trackH - thumbPx);
		const dy = e.clientY - dragStartY;
		target.scrollTop = dragStartScroll + (dy / travel) * maxScroll;
	}
	function onThumbPointerUp(e: PointerEvent) {
		dragging = false;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			/* noop */
		}
	}
	function onTrackPointerDown(e: PointerEvent) {
		if (!target || !trackEl) return;
		const rect = trackEl.getBoundingClientRect();
		const clickPct = ((e.clientY - rect.top) / rect.height) * 100;
		const thumbCenter = thumbTopPct + thumbHeightPct / 2;
		const dir = clickPct > thumbCenter ? 1 : -1;
		target.scrollBy({ top: dir * clientHeight * 0.9, behavior: 'smooth' });
	}
</script>

<div
	class="spread-scrollbar"
	class:hidden={!scrollable}
	bind:this={trackEl}
	onpointerdown={onTrackPointerDown}
	role="presentation"
	aria-hidden="true"
>
	<div
		class="thumb"
		style="height:{thumbHeightPct}%; top:{thumbTopPct}%;"
		role="presentation"
		onpointerdown={onThumbPointerDown}
		onpointermove={onThumbPointerMove}
		onpointerup={onThumbPointerUp}
		onpointercancel={onThumbPointerUp}
	></div>
</div>

<style>
	.spread-scrollbar {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 22px;
		background: rgba(255, 255, 255, 0.06);
		cursor: pointer;
		z-index: 5;
	}
	.spread-scrollbar.hidden {
		display: none;
	}
	.thumb {
		position: absolute;
		right: 3px;
		width: 16px;
		min-height: 28px;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.38);
		cursor: grab;
	}
	.thumb:active {
		cursor: grabbing;
		background: rgba(255, 255, 255, 0.6);
	}
</style>
