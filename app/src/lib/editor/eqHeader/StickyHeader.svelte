<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { onMount } from 'svelte';
	import { NO_SUBTITLE_CLASS, suppressesSubtitle } from '../subtitleSlot.js';

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
		// Mirror the editor's subtitle-slot rule onto the clone (it lives outside
		// `.tomboy-editor`, so the root class doesn't reach it) — see subtitleSlot.ts.
		contentEl.classList.toggle(NO_SUBTITLE_CLASS, suppressesSubtitle(editor.view.state.doc));
		lastClonedVersion = version;
		lastClonedBoundary = boundaryIndex;
	}

	function measure() {
		rafId = 0;
		if (!editor || !editorEl || boundaryIndex == null) {
			visible = false;
			return;
		}
		// Pin as soon as the surface is scrolled at all — not only once the
		// `===` line itself reaches the top. The fixed mirror has an opaque
		// background and covers the same top region, so it sits over the
		// still-visible real header without producing a visible duplicate.
		const scrolled =
			scrollTarget === window
				? window.scrollY
				: (scrollTarget as HTMLElement).scrollTop;
		const shouldShow = scrolled > 0;
		if (shouldShow) {
			const top =
				scrollTarget === window
					? navOffset()
					: (scrollTarget as HTMLElement).getBoundingClientRect().top;
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
		z-index: var(--z-sticky); /* below TopNav (--z-nav), above editor content */
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
	/* Cloned blocks are read-only; clicks bubble to the container (scroll-to-top).
	   Base font matches `.tomboy-editor` (16px / 1.4) so the em-based rules
	   below resolve to the same sizes as the live note. */
	.tomboy-eq-sticky-content {
		pointer-events: none;
		font-size: 16px;
		line-height: 1.4;
		color: #222;
	}

	/* ── Note-content styling ──────────────────────────────────────────────
	   The clones sit OUTSIDE `.tomboy-editor`, so its component-scoped
	   `.tomboy-editor :global(.tiptap …)` rules don't reach them and the
	   header would otherwise render as unstyled plain text. These mirror the
	   header-relevant rules in TomboyEditor.svelte — keep them in sync if the
	   note typography/marks there change. Bold/italic/strike render via the
	   browser's default <strong>/<em>/<s> styling, so they need no rule. */
	.tomboy-eq-sticky-content :global(p) {
		margin: 0;
	}
	/* First paragraph = title */
	.tomboy-eq-sticky-content :global(p:first-child) {
		font-size: 1.4em;
		font-weight: bold;
		margin-bottom: -0.4em;
	}
	/* Second paragraph = subtitle slot: smaller, muted.
	   Suppressed for `::` notes via `.tomboy-no-subtitle` (see subtitleSlot.ts). */
	.tomboy-eq-sticky-content:not(.tomboy-no-subtitle) :global(p:nth-child(2)) {
		font-size: 0.8em;
		line-height: 2.4;
		color: #666;
		padding-left: 0.1em;
	}
	/* Tomboy size marks */
	.tomboy-eq-sticky-content :global(.tomboy-size-huge) {
		font-size: 1.6em;
		font-weight: bold;
	}
	.tomboy-eq-sticky-content :global(.tomboy-size-large) {
		font-size: 1.3em;
	}
	.tomboy-eq-sticky-content :global(.tomboy-size-small) {
		font-size: 0.85em;
	}
	/* Monospace */
	.tomboy-eq-sticky-content :global(.tomboy-monospace) {
		font-family: monospace;
		background: rgba(0, 0, 0, 0.06);
		padding: 0.1em 0.3em;
		border-radius: 3px;
	}
	/* Links */
	.tomboy-eq-sticky-content :global(.tomboy-link-internal) {
		color: #204a87;
		text-decoration: underline;
	}
	.tomboy-eq-sticky-content :global(.tomboy-link-broken) {
		color: #888;
		text-decoration: line-through;
	}
	.tomboy-eq-sticky-content :global(.tomboy-link-url) {
		color: #3465a4;
		text-decoration: underline;
	}
	/* Inline image preview — width-capped, natural height (matches editor). */
	.tomboy-eq-sticky-content :global(img) {
		display: block;
		max-width: 100%;
		width: auto;
		height: auto;
		margin: 0.4em 0;
		border-radius: 4px;
	}
</style>
