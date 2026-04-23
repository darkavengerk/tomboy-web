<script lang="ts">
	import { onMount } from 'svelte';
	import { listNotes, createNote, isFavorite } from '$lib/core/noteManager.js';
	import type { NoteData } from '$lib/core/note.js';
	import { parseTomboyDate } from '$lib/core/note.js';
	import {
		getCachedNotebooks,
		filterByNotebook,
		refreshNotebooksCache,
		assignNotebook
	} from '$lib/core/notebooks.js';
	import { SLIPBOX_NOTEBOOK } from '$lib/sleepnote/validator.js';
	import { createSlipNote } from '$lib/sleepnote/create.js';
	import { searchNotes } from '$lib/search/noteSearch.js';
	import {
		getCachedNotes,
		setCachedNotes,
		onInvalidate
	} from '$lib/stores/noteListCache.js';
	import { recentOpens } from './recentOpens.svelte.js';
	import {
		sidePanelLayout,
		RAIL_MIN_WIDTH,
		RAIL_MAX_WIDTH,
		MAIN_MIN_WIDTH,
		MAIN_MAX_WIDTH
	} from './sidePanelLayout.svelte.js';
	import { startPointerDrag } from './dragResize.js';

	// Workspace 1 (top-right of the 2x2 grid) is the dedicated slipnote
	// workspace: entering it auto-selects the [0] Slip-Box notebook and
	// pins the .main panel open so the user can navigate slipnotes
	// without having to hover the rail every time.
	const SLIPNOTE_WORKSPACE_INDEX = 1;

	interface Props {
		openGuids: Set<string>;
		currentWorkspace: number;
		workspaceSummaries: Array<{ index: number; windowCount: number }>;
		onopen: (guid: string) => void;
		onopensettings: () => void;
		onswitchworkspace: (index: number) => void;
	}

	let {
		openGuids,
		currentWorkspace,
		workspaceSummaries,
		onopen,
		onopensettings,
		onswitchworkspace
	}: Props = $props();

	let allNotes: NoteData[] = $state(getCachedNotes() ?? []);
	let loading = $state(getCachedNotes() === null);
	let notebooks: string[] = $state([]);
	let selectedNotebook = $state<string | null>(null);
	let query = $state('');

	const filteredNotes = $derived.by(() => {
		const filtered = filterByNotebook(allNotes, selectedNotebook);
		const q = query.trim();
		const base = q ? searchNotes(filtered, q, 200).map((r) => r.note) : filtered;
		// Side panel is a "recents" surface ordered by when the user last
		// opened a note in desktop mode (recentOpens, local-only). Notes
		// without an open record fall back to changeDate. Pinned notes stay
		// at the top regardless. Cap so long histories don't balloon DOM.
		const recents = recentOpens.map;
		const keyed = base.map((n) => {
			const opened = recents[n.guid];
			let key = opened ?? 0;
			if (!opened) {
				const t = parseTomboyDate(n.changeDate).getTime();
				key = Number.isFinite(t) ? t : 0;
			}
			return { n, key };
		});
		keyed.sort((a, b) => {
			const pa = isFavorite(a.n) ? 1 : 0;
			const pb = isFavorite(b.n) ? 1 : 0;
			if (pa !== pb) return pb - pa;
			return b.key - a.key;
		});
		return keyed.slice(0, 50).map((x) => x.n);
	});

	async function refresh() {
		const fresh = await listNotes();
		allNotes = fresh;
		setCachedNotes(fresh);
		loading = false;
	}

	onMount(() => {
		refresh();
		getCachedNotebooks().then((n) => {
			notebooks = n;
		});
		const off = onInvalidate(() => {
			refresh();
			refreshNotebooksCache().then((n) => {
				notebooks = n;
			});
		});
		return () => off();
	});

	async function handleNew() {
		const note =
			selectedNotebook === SLIPBOX_NOTEBOOK
				? await createSlipNote()
				: await createNote();
		if (selectedNotebook) {
			await assignNotebook(note.guid, selectedNotebook);
		}
		onopen(note.guid);
	}

	function selectNotebook(name: string | null) {
		selectedNotebook = name;
	}

	// Workspace switch resets the notebook filter: ws 1 snaps to
	// [0] Slip-Box, every other workspace snaps to "전체" (null). The
	// effect re-runs only when currentWorkspace changes, so manual chip
	// clicks within a workspace are respected until the next switch.
	$effect(() => {
		selectedNotebook =
			currentWorkspace === SLIPNOTE_WORKSPACE_INDEX ? SLIPBOX_NOTEBOOK : null;
	});

	const alwaysOpen = $derived(currentWorkspace === SLIPNOTE_WORKSPACE_INDEX);

	let resizingRail = $state(false);
	let resizingMain = $state(false);

	function onRailResizeStart(e: PointerEvent) {
		const start = sidePanelLayout.railWidth;
		resizingRail = true;
		startPointerDrag(e, {
			onMove: (dx) => sidePanelLayout.setRailWidth(start + dx),
			onEnd: () => {
				resizingRail = false;
			}
		});
	}

	function onMainResizeStart(e: PointerEvent) {
		const start = sidePanelLayout.mainWidth;
		resizingMain = true;
		startPointerDrag(e, {
			onMove: (dx) => sidePanelLayout.setMainWidth(start + dx),
			onEnd: () => {
				resizingMain = false;
			}
		});
	}
</script>

<aside
	class="side-panel"
	class:always-open={alwaysOpen}
	aria-label="노트 메뉴"
	style="width: {sidePanelLayout.railWidth + sidePanelLayout.mainWidth}px;"
>
	<!--
		Rail: always visible, hosts only the workspace switcher. Its width
		defines how much of the canvas is permanently reserved on the right
		(canvas is sized to stop exactly where the rail starts).
	-->
	<div
		class="rail"
		style="flex-basis: {sidePanelLayout.railWidth}px;"
	>
		<div class="workspace-switcher" role="group" aria-label="작업 공간">
			{#each workspaceSummaries as ws (ws.index)}
				<button
					type="button"
					class="quadrant"
					class:active={currentWorkspace === ws.index}
					aria-current={currentWorkspace === ws.index ? 'true' : undefined}
					aria-label={`작업 공간 ${ws.index + 1} — 창 ${ws.windowCount}개`}
					title={`작업 공간 ${ws.index + 1} — 창 ${ws.windowCount}개`}
					onclick={() => onswitchworkspace(ws.index)}
				>
					{#if ws.windowCount > 0}
						<span class="count">{ws.windowCount}</span>
					{/if}
				</button>
			{/each}
		</div>

		<div class="rail-chips" role="tablist" aria-label="노트북 필터">
			<button
				type="button"
				role="tab"
				class="rail-chip"
				class:active={selectedNotebook === null}
				aria-selected={selectedNotebook === null}
				title="전체"
				onclick={() => selectNotebook(null)}
			>전체</button>
			<button
				type="button"
				role="tab"
				class="rail-chip"
				class:active={selectedNotebook === ''}
				aria-selected={selectedNotebook === ''}
				title="미분류"
				onclick={() => selectNotebook('')}
			>미분류</button>
			{#each notebooks as nb (nb)}
				<button
					type="button"
					role="tab"
					class="rail-chip"
					class:active={selectedNotebook === nb}
					aria-selected={selectedNotebook === nb}
					title={nb}
					onclick={() => selectNotebook(nb)}
				>{nb}</button>
			{/each}
		</div>

		<a
			class="rail-settings rail-graph"
			href="/desktop/graph"
			target="_blank"
			rel="noopener"
			title="노트 그래프 (새 탭)"
			aria-label="노트 그래프"
		>그래프</a>

		<button
			type="button"
			class="rail-settings"
			onclick={onopensettings}
			title="설정"
			aria-label="설정"
		>설정</button>
	</div>

	<!--
		Rail resize handle: 6px-wide grip at the rail's right edge. Drag
		changes the rail's flex-basis (and the canvas's left offset, via
		sidePanelLayout). Sits above .main so it stays grabbable even when
		the panel is collapsed.
	-->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="resize-handle"
		class:resizing={resizingRail}
		role="separator"
		aria-orientation="vertical"
		aria-label="작업줄 크기 조절"
		aria-valuenow={sidePanelLayout.railWidth}
		aria-valuemin={RAIL_MIN_WIDTH}
		aria-valuemax={RAIL_MAX_WIDTH}
		style="left: {sidePanelLayout.railWidth}px;"
		onpointerdown={onRailResizeStart}
	></div>

	<!--
		Main resize handle: same grip at the .main column's right edge. Drag
		updates mainWidth in sidePanelLayout. Always present (even when
		.main is hover-collapsed) — visible/usable mainly in the slipnote
		workspace where .main is pinned open.
	-->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="resize-handle main-handle"
		class:resizing={resizingMain}
		role="separator"
		aria-orientation="vertical"
		aria-label="확장 영역 크기 조절"
		aria-valuenow={sidePanelLayout.mainWidth}
		aria-valuemin={MAIN_MIN_WIDTH}
		aria-valuemax={MAIN_MAX_WIDTH}
		style="left: {sidePanelLayout.railWidth + sidePanelLayout.mainWidth}px;"
		onpointerdown={onMainResizeStart}
	></div>

	<!--
		Main content: search, new-note, notebook chips, note list, footer.
		Slides off-screen to the right when the panel is not hovered and
		overlays the canvas on hover. Canvas geometry is unaffected.
	-->
	<div class="main" style="flex-basis: {sidePanelLayout.mainWidth}px;">
		<div class="header">
			<input
				type="search"
				placeholder="검색"
				bind:value={query}
				aria-label="노트 검색"
			/>
			<button type="button" class="new-btn" onclick={handleNew} title="새 노트">＋ 새 노트</button>
		</div>

		<div class="list">
			{#if loading}
				<div class="empty">로딩 중...</div>
			{:else if filteredNotes.length === 0}
				<div class="empty">노트가 없습니다.</div>
			{:else}
				<ul>
					{#each filteredNotes as n (n.guid)}
						<li>
							<button
								type="button"
								class="note-item"
								class:open={openGuids.has(n.guid)}
								onclick={() => onopen(n.guid)}
								title={n.title}
							>
								<span class="title">{n.title || '제목 없음'}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

	</div>
</aside>

<style>
	.side-panel {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		/* width is set inline so it grows with the user-resizable rail. */
		display: flex;
		flex-direction: row;
		color: #eee;
		z-index: 100000;
		/* The side-panel box spans the full expanded width so .main can
		   occupy its eventual position when revealed. But we don't want the
		   full box to capture hover — only the visible rail should. Setting
		   pointer-events: none on the container lets child elements opt back
		   in individually; the collapsed .main area passes clicks through to
		   notes beneath. */
		pointer-events: none;
	}

	/* Rail: always-visible left column. Sits flush to the screen's left edge
	   so the shrunk panel remains visible at all times. flex-basis is set
	   inline so the user-resizable width takes effect on every render. */
	.rail {
		flex: 0 0 80px;
		background: #1a1a1a;
		border-right: 1px solid #333;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 10px 0;
		gap: 10px;
		overflow: hidden;
		min-height: 0;
		pointer-events: auto;
	}

	/* Vertical drag grip at the rail's right edge. 6px hit target with a
	   1px visible line so it doesn't fight the rail border for attention. */
	.resize-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		margin-left: -2px;
		cursor: ew-resize;
		pointer-events: auto;
		z-index: 1;
		background: transparent;
		transition: background 120ms ease;
	}

	.resize-handle:hover,
	.resize-handle.resizing {
		background: rgba(90, 153, 255, 0.35);
	}

	.rail-chips {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 4px;
		width: 100%;
		padding: 0 6px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.rail-chip {
		padding: 5px 6px;
		border-radius: 4px;
		border: 1px solid #2a2a2a;
		background: #111;
		color: #bbb;
		font-size: 0.7rem;
		cursor: pointer;
		text-align: center;
		line-height: 1.2;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.rail-chip:hover {
		background: #232323;
		color: #fff;
	}

	.rail-chip.active {
		background: #2d5a3d;
		color: #fff;
		border-color: #3a7a50;
	}

	/* Main: revealed column to the right of the rail. When collapsed it is
	   clipped away (not translated), so expanding reveals the hidden content
	   growing out from behind the rail rather than sliding in as a block.
	   flex-basis is set inline so the user-resizable width takes effect on
	   every render. */
	.main {
		flex: 0 0 220px;
		min-width: 0;
		background: #1a1a1a;
		border-right: 1px solid #333;
		display: flex;
		flex-direction: column;
		clip-path: inset(0 100% 0 0);
		pointer-events: none;
		transition: clip-path 180ms ease;
	}

	/* Reveal triggers: hovering ANY part of the side-panel (rail, either
	   resize handle, or .main itself), or keyboard focus inside .main. The
	   side-panel container has pointer-events: none, but :hover still
	   propagates up from descendants whose pointer-events are auto, so this
	   rule activates as soon as the mouse enters any interactive child and
	   stays activated as it traverses between them — including across the
	   resize handle that sits between rail and main. We deliberately do
	   NOT match focus-within on the whole side-panel; chip /
	   workspace-quadrant clicks in the rail would otherwise latch the
	   panel open after the mouse leaves. */
	.side-panel:hover .main,
	.main:focus-within,
	.side-panel.always-open .main {
		clip-path: inset(0 0 0 0);
		pointer-events: auto;
	}

	/* In the slipnote workspace .main is pinned open, so its drag transition
	   would feel laggy when entering/leaving. Drop the transition here. */
	.side-panel.always-open .main {
		transition: none;
	}

	.header {
		padding: 12px 12px 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-bottom: 1px solid #2a2a2a;
		flex-shrink: 0;
	}

	.header input {
		width: 100%;
		padding: 6px 10px;
		border-radius: 4px;
		border: 1px solid #333;
		background: #111;
		color: #eee;
		font-size: 0.85rem;
		outline: none;
	}

	.header input:focus {
		border-color: #5a9;
	}

	.new-btn {
		padding: 6px 10px;
		background: #2d5a3d;
		color: #eee;
		border: 1px solid #3a7a50;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
		text-align: left;
	}

	.new-btn:hover {
		background: #3a7a50;
	}

	.workspace-switcher {
		display: grid;
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 1fr 1fr;
		gap: 4px;
		width: calc(100% - 12px);
		aspect-ratio: 1 / 1;
		padding: 4px;
		background: #111;
		border: 1px solid #333;
		border-radius: 4px;
		flex-shrink: 0;
	}

	.quadrant {
		position: relative;
		padding: 0;
		background: #1f1f1f;
		border: 1px solid #2a2a2a;
		border-radius: 2px;
		cursor: pointer;
		color: #888;
		font-size: 0.8rem;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.quadrant:hover {
		background: #2a2a2a;
		border-color: #3a7a50;
	}

	.quadrant.active {
		background: #2d5a3d;
		border-color: #5ab378;
		color: #fff;
	}

	.quadrant .count {
		font-weight: 600;
	}

	.list {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.list ul {
		list-style: none;
		padding: 4px 0;
		margin: 0;
	}

	.note-item {
		display: block;
		width: 100%;
		padding: 7px 12px;
		background: transparent;
		border: none;
		border-right: 3px solid transparent;
		color: #ddd;
		text-align: left;
		cursor: pointer;
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.note-item:hover {
		background: #232323;
	}

	.note-item.open {
		border-right-color: #5a9;
		background: #1f1f1f;
		font-weight: 600;
		color: #fff;
	}

	.title {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty {
		padding: 24px 12px;
		text-align: center;
		color: #888;
		font-size: 0.85rem;
	}

	/* Settings lives in the rail so it stays visible when the panel is
	   collapsed. It is outside the scrollable .rail-chips column on purpose:
	   the chips scroll independently while this button stays pinned at the
	   bottom of the rail. */
	.rail-settings {
		flex-shrink: 0;
		margin-top: auto;
		width: calc(100% - 12px);
		padding: 6px 4px;
		border-radius: 4px;
		border: 1px solid #2a2a2a;
		background: #111;
		color: #bbb;
		font-size: 0.7rem;
		cursor: pointer;
		text-align: center;
		line-height: 1.2;
	}

	.rail-settings:hover {
		background: #232323;
		color: #fff;
	}

	/* Anchor variant for the graph link — mirrors rail-settings styling so
	   it stacks identically above the settings button. margin-top: auto on
	   rail-settings would push this one down too; we reset it here. */
	.rail-graph {
		display: block;
		text-decoration: none;
		margin-top: auto;
	}

	.rail-graph + .rail-settings {
		margin-top: 0;
	}
</style>
