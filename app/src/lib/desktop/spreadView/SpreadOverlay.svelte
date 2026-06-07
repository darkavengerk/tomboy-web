<script lang="ts">
	import { desktopSession } from '$lib/desktop/session.svelte.js';
	import { spreadView } from '$lib/desktop/spreadView/spreadView.svelte.js';
	import { packShelves, type Box } from '$lib/desktop/spreadView/packShelves.js';
	import SpreadScrollbar from '$lib/desktop/spreadView/SpreadScrollbar.svelte';

	const GAP = 16;
	const PADDING = 24;
	const SCROLLBAR_W = 22;

	let scrollEl: HTMLDivElement | undefined = $state(undefined);
	let containerWidth = $state(1000);

	// Current-workspace note windows, row-major by original position.
	const noteWindows = $derived(
		desktopSession.windows
			.filter((w) => w.kind === 'note')
			.slice()
			.sort((a, b) => a.y - b.y || a.x - b.x)
	);

	const layout = $derived.by(() => {
		const boxes: Box[] = noteWindows.map((w) => ({ guid: w.guid, w: w.width, h: w.height }));
		return packShelves(boxes, containerWidth, GAP);
	});

	function measure() {
		if (!scrollEl) return;
		containerWidth = Math.max(200, scrollEl.clientWidth - PADDING * 2);
	}

	$effect(() => {
		measure();
		if (typeof window === 'undefined') return;
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	});

	// Esc closes the overlay first — capture beats NoteWindow's bubble-phase
	// Esc-to-close handler.
	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopImmediatePropagation();
				spreadView.close();
			}
		};
		window.addEventListener('keydown', onKey, { capture: true });
		return () => window.removeEventListener('keydown', onKey, { capture: true });
	});

	function jumpTo(guid: string) {
		spreadView.close();
		desktopSession.focusWindow(guid);
	}

	function titleFor(guid: string): string {
		return desktopSession.getSnapshotSource(guid)?.title ?? '제목 없음';
	}

	// Svelte action: clone the live content element into the card body as an
	// inert read-only snapshot. pointer-events:none on the clone so clicks fall
	// through to the card (→ jumpTo) and wheel targets the scrollable body.
	function snapshot(node: HTMLElement, guid: string) {
		function mount(g: string) {
			node.replaceChildren();
			const src = desktopSession.getSnapshotSource(g);
			if (src?.el) {
				const clone = src.el.cloneNode(true) as HTMLElement;
				clone.style.pointerEvents = 'none';
				clone.style.userSelect = 'none';
				clone.setAttribute('contenteditable', 'false');
				clone
					.querySelectorAll('[contenteditable="true"]')
					.forEach((el) => el.setAttribute('contenteditable', 'false'));
				node.appendChild(clone);
			} else {
				const p = document.createElement('p');
				p.className = 'spread-empty';
				p.textContent = '미리보기 없음';
				node.appendChild(p);
			}
		}
		mount(guid);
		return {
			update(g: string) {
				mount(g);
			},
			destroy() {
				node.replaceChildren();
			}
		};
	}
</script>

<div class="spread-overlay" role="dialog" aria-modal="true" aria-label="펼쳐보기">
	<button
		type="button"
		class="spread-close"
		onclick={() => spreadView.close()}
		title="닫기 (Esc)"
		aria-label="펼쳐보기 닫기"
	>✕</button>

	<div class="spread-scroll" bind:this={scrollEl} style="--pad:{PADDING}px; --sb:{SCROLLBAR_W}px;">
		<div class="spread-content" style="height:{layout.totalHeight}px; width:{containerWidth}px;">
			{#each layout.placed as p (p.guid)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="spread-card"
					style="left:{p.x}px; top:{p.y}px; width:{p.w}px; height:{p.h}px;"
					role="button"
					tabindex="0"
					title={titleFor(p.guid)}
					onclick={() => jumpTo(p.guid)}
					onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && jumpTo(p.guid)}
				>
					<div class="spread-card-title">{titleFor(p.guid)}</div>
					<div class="spread-card-body" use:snapshot={p.guid}></div>
				</div>
			{/each}
		</div>
	</div>

	<SpreadScrollbar target={scrollEl ?? null} />
</div>

<style>
	.spread-overlay {
		position: fixed;
		inset: 0;
		/* Above pinned windows (1_000_000 + raw z in DesktopWorkspace). */
		z-index: 2000000;
		background: rgba(10, 10, 12, 0.92);
	}
	.spread-scroll {
		position: absolute;
		top: 0;
		left: 0;
		bottom: 0;
		right: var(--sb);
		overflow-y: auto;
		overflow-x: hidden;
		padding: var(--pad);
		scrollbar-width: none; /* hide native; the custom scrollbar drives it */
	}
	.spread-scroll::-webkit-scrollbar {
		display: none;
	}
	.spread-content {
		position: relative;
	}
	.spread-card {
		position: absolute;
		display: flex;
		flex-direction: column;
		background: #fff;
		color: #212529;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid rgba(0, 0, 0, 0.15);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}
	.spread-card:hover {
		outline: 2px solid #4c8dff;
	}
	.spread-card-title {
		flex-shrink: 0;
		padding: 6px 10px;
		font-size: 0.82rem;
		font-weight: 600;
		background: #f1f3f5;
		border-bottom: 1px solid #e0e0e0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.spread-card-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		/* Wheel scrolling stays inside the card — never chains to the gallery
		   (page scroll is the right-side scrollbar's job). */
		overscroll-behavior: contain;
	}
	/* The cloned editor brings its own inner scroll; neutralize it so the card
	   body's scroll viewport drives the full content height. */
	.spread-card-body :global(.tomboy-editor) {
		overflow: visible !important;
		height: auto !important;
	}
	.spread-card-body :global(.spread-empty) {
		padding: 16px;
		color: #888;
	}
	.spread-close {
		position: absolute;
		top: 12px;
		right: calc(var(--sb, 22px) + 12px);
		z-index: 6;
		width: 36px;
		height: 36px;
		border: none;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.15);
		color: #fff;
		font-size: 1.1rem;
		cursor: pointer;
	}
	.spread-close:hover {
		background: rgba(255, 255, 255, 0.3);
	}
</style>
