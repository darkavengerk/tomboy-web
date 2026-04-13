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
		onopen: (guid: string) => void;
		onopensettings: () => void;
	}

	let { openGuids, onopen, onopensettings }: Props = $props();

	let allNotes: NoteData[] = $state(getCachedNotes() ?? []);
	let loading = $state(getCachedNotes() === null);
	let notebooks: string[] = $state([]);
	let selectedNotebook = $state<string | null>(null);
	let query = $state('');

	const filteredNotes = $derived.by(() => {
		const filtered = filterByNotebook(allNotes, selectedNotebook);
		const q = query.trim();
		const base = q ? searchNotes(filtered, q, 200).map((r) => r.note) : filtered;
		return sortForList(base, 'changeDate');
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
	<div class="header">
		<input
			type="search"
			placeholder="검색"
			bind:value={query}
			aria-label="노트 검색"
		/>
		<button type="button" class="new-btn" onclick={handleNew} title="새 노트">＋ 새 노트</button>
	</div>

	<div class="chips" role="tablist" aria-label="노트북 필터">
		<button
			type="button"
			role="tab"
			class="chip"
			class:active={selectedNotebook === null}
			aria-selected={selectedNotebook === null}
			onclick={() => selectNotebook(null)}
		>전체</button>
		<button
			type="button"
			role="tab"
			class="chip"
			class:active={selectedNotebook === ''}
			aria-selected={selectedNotebook === ''}
			onclick={() => selectNotebook('')}
		>미분류</button>
		{#each notebooks as nb (nb)}
			<button
				type="button"
				role="tab"
				class="chip"
				class:active={selectedNotebook === nb}
				aria-selected={selectedNotebook === nb}
				onclick={() => selectNotebook(nb)}
			>🗂 {nb}</button>
		{/each}
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

	<div class="footer">
		<button type="button" class="settings-link" onclick={onopensettings}>설정</button>
	</div>
</aside>

<style>
	.side-panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 300px;
		background: #1a1a1a;
		color: #eee;
		display: flex;
		flex-direction: column;
		border-left: 1px solid #333;
		z-index: 100000;
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

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 8px 12px;
		border-bottom: 1px solid #2a2a2a;
		flex-shrink: 0;
		max-height: 88px;
		overflow-y: auto;
	}

	.chip {
		padding: 3px 8px;
		border-radius: 10px;
		border: 1px solid #333;
		background: #111;
		color: #bbb;
		font-size: 0.75rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.chip.active {
		background: #2d5a3d;
		color: #fff;
		border-color: #3a7a50;
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

	.footer {
		padding: 8px 12px;
		border-top: 1px solid #2a2a2a;
		flex-shrink: 0;
	}

	.settings-link {
		background: none;
		border: none;
		padding: 0;
		color: #aaa;
		font-size: 0.85rem;
		text-decoration: none;
		cursor: pointer;
	}

	.settings-link:hover {
		color: #fff;
		text-decoration: underline;
	}
</style>
