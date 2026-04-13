<script lang="ts">
	import { onMount } from 'svelte';
	import { listNotes, createNote, sortForList } from '$lib/core/noteManager.js';
	import type { NoteData } from '$lib/core/note.js';
	import {
		getCachedNotebooks,
		filterByNotebook,
		refreshNotebooksCache
	} from '$lib/core/notebooks.js';
	import { searchNotes } from '$lib/search/noteSearch.js';
	import {
		getCachedNotes,
		setCachedNotes,
		onInvalidate
	} from '$lib/stores/noteListCache.js';

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
		// Side panel is a "recents" surface — cap the list so long histories
		// don't balloon the DOM. 30 is enough for quick access; users who
		// need more can use search.
		return sortForList(base, 'changeDate').slice(0, 30);
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
		const note = await createNote('새 노트');
		onopen(note.guid);
	}

	function selectNotebook(name: string | null) {
		selectedNotebook = name;
	}
</script>

<aside class="side-panel" aria-label="노트 메뉴">
	<!--
		Rail: always visible, hosts only the workspace switcher. Its width
		defines how much of the canvas is permanently reserved on the right
		(canvas is sized to stop exactly where the rail starts).
	-->
	<div class="rail">
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

		<button
			type="button"
			class="rail-settings"
			onclick={onopensettings}
			title="설정"
			aria-label="설정"
		>설정</button>
	</div>

	<!--
		Main content: search, new-note, notebook chips, note list, footer.
		Slides off-screen to the right when the panel is not hovered and
		overlays the canvas on hover. Canvas geometry is unaffected.
	-->
	<div class="main">
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
		width: 300px;
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
	   so the shrunk panel remains visible at all times. */
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
	   growing out from behind the rail rather than sliding in as a block. */
	.main {
		flex: 1;
		min-width: 0;
		background: #1a1a1a;
		border-right: 1px solid #333;
		display: flex;
		flex-direction: column;
		clip-path: inset(0 100% 0 0);
		pointer-events: none;
		transition: clip-path 180ms ease;
	}

	/* Reveal triggers: hovering the always-visible rail, or keyboard focus
	   anywhere in the panel. Once revealed, hovering .main itself keeps it
	   open so the mouse can cross from rail into main without flicker. */
	.rail:hover ~ .main,
	.main:hover,
	.side-panel:focus-within .main {
		clip-path: inset(0 0 0 0);
		pointer-events: auto;
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
		gap: 3px;
		width: 44px;
		aspect-ratio: 1 / 1;
		padding: 3px;
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
		font-size: 0.65rem;
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
		border-left: 3px solid transparent;
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
		border-left-color: #5a9;
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
</style>
