<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { onMount } from 'svelte';

	interface Props {
		/** Live editor (DOM source for cloning). */
		editor: Editor | null;
		/** The `.tomboy-editor` element — used to detect the scroll container
		 *  and to align the mirror's left/width to the editor column. */
		editorEl: HTMLElement | null;
		/** Active boundary top-level index, or null when no `===` present. */
		boundaryIndex: number | null;
		/** Bumped by the plugin on every doc change → triggers re-clone. */
		version: number;
	}
	let { editor, editorEl, boundaryIndex, version }: Props = $props();

	let contentEl: HTMLDivElement | null = $state(null);
	let visible = $state(false);
	let pinTop = $state(0);
	let pinLeft = $state(0);
	let pinWidth = $state(0);

	let scrollTarget: HTMLElement | Window = window;
	let lastClonedVersion = -1;
	let lastClonedBoundary: number | null = null;
	let rafId = 0;

	/** Nearest scrollable ancestor of `el` (inclusive), else window. */
	function findScrollContainer(el: HTMLElement | null): HTMLElement | Window {
		let cur: HTMLElement | null = el;
		while (cur && cur !== document.body) {
			const oy = getComputedStyle(cur).overflowY;
			if (oy === 'auto' || oy === 'scroll') return cur;
			cur = cur.parentElement;
		}
		return window;
	}

	/** On the mobile route the global TopNav is `position: sticky; top:0`, so
	 *  the free viewport for note content begins at its bottom edge. Chromeless
	 *  desktop windows (element scroll containers) have no such nav. */
	function navOffset(): number {
		const nav = document.querySelector('.topnav') as HTMLElement | null;
		if (!nav) return 0;
		const pos = getComputedStyle(nav).position;
		if (pos !== 'sticky' && pos !== 'fixed') return 0;
		const r = nav.getBoundingClientRect();
		return r.top <= 0.5 ? Math.max(0, r.bottom) : 0;
	}

	function cloneHeader() {
		if (!editor || !contentEl || boundaryIndex == null) return;
		const dom = editor.view.dom as HTMLElement;
		contentEl.replaceChildren();
		const n = Math.min(boundaryIndex, dom.children.length);
		for (let i = 0; i < n; i++) {
			const clone = dom.children[i].cloneNode(true) as HTMLElement;
			clone.removeAttribute('contenteditable');
			clone
				.querySelectorAll('[contenteditable]')
				.forEach((el) => (el as HTMLElement).removeAttribute('contenteditable'));
			// Force eager loading on cloned images — the mirror appears already
			// scrolled into view, so `loading="lazy"` (set by imagePreviewPlugin)
			// would otherwise show a blank frame until the clone enters view.
			clone
				.querySelectorAll('img[loading="lazy"]')
				.forEach((el) => (el as HTMLImageElement).setAttribute('loading', 'eager'));
			contentEl.appendChild(clone);
		}
		lastClonedVersion = version;
		lastClonedBoundary = boundaryIndex;
	}

	function measure() {
		rafId = 0;
		if (!editor || !editorEl || boundaryIndex == null) {
			visible = false;
			return;
		}
		const dom = editor.view.dom as HTMLElement;
		const markerEl = dom.children[boundaryIndex] as HTMLElement | undefined;
		if (!markerEl) {
			visible = false;
			return;
		}
		const top =
			scrollTarget === window
				? navOffset()
				: (scrollTarget as HTMLElement).getBoundingClientRect().top;
		const markerTop = markerEl.getBoundingClientRect().top;
		const shouldShow = markerTop <= top + 0.5;
		if (shouldShow) {
			const er = editorEl.getBoundingClientRect();
			pinTop = top;
			pinLeft = er.left;
			pinWidth = er.width;
			if (lastClonedVersion !== version || lastClonedBoundary !== boundaryIndex) {
				cloneHeader();
			}
		}
		visible = shouldShow;
	}

	function schedule() {
		if (rafId) return;
		rafId = requestAnimationFrame(measure);
	}

	function scrollToTop() {
		(scrollTarget as Window | HTMLElement).scrollTo({ top: 0, behavior: 'smooth' });
	}

	let ro: ResizeObserver | null = null;
	onMount(() => {
		scrollTarget = findScrollContainer(editorEl);
		scrollTarget.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule, { passive: true });
		if (editorEl) {
			ro = new ResizeObserver(schedule);
			ro.observe(editorEl);
		}
		schedule();
		return () => {
			scrollTarget.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			ro?.disconnect();
			if (rafId) cancelAnimationFrame(rafId);
		};
	});

	// Re-measure (and re-clone) whenever the doc version or boundary changes.
	$effect(() => {
		version;
		boundaryIndex;
		schedule();
	});
</script>

{#if boundaryIndex != null}
	<div
		class="tomboy-eq-sticky"
		class:visible
		style="top:{pinTop}px; left:{pinLeft}px; width:{pinWidth}px;"
		role="button"
		tabindex="0"
		title="맨 위로"
		onclick={scrollToTop}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				scrollToTop();
			}
		}}
	>
		<!-- Cloned header is a visual duplicate of the in-doc header; hide it
		     from assistive tech so the content isn't announced twice. -->
		<div class="tomboy-eq-sticky-content" bind:this={contentEl} aria-hidden="true"></div>
	</div>
{/if}

<style>
	.tomboy-eq-sticky {
		position: fixed;
		z-index: 15; /* below TopNav (20), above editor content */
		display: none;
		max-height: 40vh;
		overflow-y: auto;
		background: #fff;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
		border-bottom: 3px solid #333;
		cursor: pointer;
		box-sizing: border-box;
		padding: 0.25rem 0.5rem;
	}
	.tomboy-eq-sticky.visible {
		display: block;
	}
	/* Cloned blocks are read-only; clicks bubble to the container (scroll-to-top). */
	.tomboy-eq-sticky-content {
		pointer-events: none;
		font-size: 16px;
		line-height: 1.4;
		color: #222;
	}
	.tomboy-eq-sticky-content :global(p) {
		margin: 0.2em 0;
	}
	.tomboy-eq-sticky-content :global(img) {
		max-width: 100%;
		height: auto;
	}
</style>
