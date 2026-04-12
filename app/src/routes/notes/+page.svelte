<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { listNotes } from '$lib/core/noteManager.js';
	import type { NoteData } from '$lib/core/note.js';
	import NoteList from '$lib/components/NoteList.svelte';
	import { getSetting, setSetting } from '$lib/storage/appSettings.js';
	import {
		getCachedNotes,
		setCachedNotes,
		getCachedScrollTop,
		setCachedScrollTop,
		onInvalidate
	} from '$lib/stores/noteListCache.js';
	import { goto } from '$app/navigation';
	import { getCachedNotebooks, filterByNotebook } from '$lib/core/notebooks.js';
	import { searchNotes } from '$lib/search/noteSearch.js';

	type SortKey = 'changeDate' | 'createDate';
	const SORT_KEY = 'listSort:all';

	let allNotes: NoteData[] = $state(getCachedNotes() ?? []);
	let loading = $state(getCachedNotes() === null);
	let sortBy = $state<SortKey>('changeDate');
	let container: HTMLElement | undefined = $state(undefined);
	let notebooks: string[] = $state([]);
	let pickerOpen = $state(false);
	let query = $state('');

	// 현재 URL 쿼리에서 notebook 파라미터 읽기
	const selectedNotebook = $derived(page.url.searchParams.get('notebook'));

	// 노트북 필터 → 검색어 순으로 적용
	const notes = $derived.by(() => {
		const filtered = filterByNotebook(allNotes, selectedNotebook);
		const q = query.trim();
		if (!q) return filtered;
		return searchNotes(filtered, q, 200).map((r) => r.note);
	});

	async function refresh() {
		const fresh = await listNotes();
		allNotes = fresh;
		setCachedNotes(fresh);
		loading = false;
	}

	onMount(() => {
		getSetting<SortKey>(SORT_KEY).then((v) => { if (v) sortBy = v; });
		if (container) container.scrollTop = getCachedScrollTop();
		refresh();
		getCachedNotebooks().then((n) => { notebooks = n; });
		const off = onInvalidate(refresh);
		return () => off();
	});

	beforeNavigate(() => {
		if (container) setCachedScrollTop(container.scrollTop);
	});

	function handleScroll() {
		if (container) setCachedScrollTop(container.scrollTop);
	}

	function handleSort(k: SortKey) {
		sortBy = k;
		setSetting(SORT_KEY, k);
	}

	function selectNotebook(name: string | null) {
		const href = name === null ? '/notes' : `/notes?notebook=${encodeURIComponent(name)}`;
		goto(href);
		pickerOpen = false;
	}

	function handlePickerKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') pickerOpen = false;
	}
</script>

<div class="page">
	<div class="filter-bar">
		<div class="filter-left">
			{#if notebooks.length > 0}
				<button
					class="filter-select"
					onclick={() => (pickerOpen = true)}
					aria-haspopup="listbox"
					aria-expanded={pickerOpen}
				>
					<span class="filter-label">
						{selectedNotebook === null ? '전체' : `🗂 ${selectedNotebook}`}
					</span>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</button>
			{/if}
			<select
				class="sort-select"
				value={sortBy}
				onchange={(e) => handleSort((e.currentTarget as HTMLSelectElement).value as SortKey)}
			>
				<option value="changeDate">최근 수정순</option>
				<option value="createDate">생성순</option>
			</select>
			<span class="note-count">{notes.length}개</span>
		</div>
		<div class="search-wrap">
			<svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
			</svg>
			<input
				bind:value={query}
				type="search"
				placeholder="검색"
				class="search-input"
				aria-label="노트 검색"
			/>
		</div>
	</div>

	<div class="list-container" bind:this={container} onscroll={handleScroll}>
		{#if loading}
			<p class="loading">로딩 중...</p>
		{:else}
			<NoteList {notes} {sortBy} />
		{/if}
	</div>
</div>

<svelte:window onkeydown={handlePickerKeydown} />

{#if pickerOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={() => (pickerOpen = false)}></div>
	<div class="sheet" role="dialog" aria-modal="true" aria-label="노트북 필터">
		<div class="sheet-handle"></div>
		<div class="sheet-title">노트북 선택</div>
		<div class="sheet-options">
			<button
				class="sheet-option"
				class:active={selectedNotebook === null}
				onclick={() => selectNotebook(null)}
			>
				전체{selectedNotebook === null ? ' (선택됨)' : ''}
			</button>
			{#each notebooks as nb (nb)}
				<button
					class="sheet-option"
					class:active={selectedNotebook === nb}
					onclick={() => selectNotebook(nb)}
				>
					🗂 {nb}{selectedNotebook === nb ? ' (선택됨)' : ''}
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.filter-bar {
		display: flex;
		align-items: center;
		gap: clamp(4px, 1.5vw, 8px);
		padding: clamp(4px, 1.2vw, 6px) clamp(6px, 2vw, 12px);
		flex-shrink: 0;
		border-bottom: 1px solid var(--color-border, #eee);
	}

	.filter-left {
		display: flex;
		align-items: center;
		gap: clamp(4px, 1.5vw, 8px);
		min-width: 0;
		flex-shrink: 1;
	}

	.filter-select {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: clamp(3px, 1vw, 5px) clamp(6px, 2vw, 10px);
		border-radius: 16px;
		font-size: clamp(0.72rem, 2.4vw, 0.82rem);
		font-weight: 500;
		background: var(--color-bg-secondary, #f5f5f5);
		color: var(--color-text, #111);
		border: none;
		cursor: pointer;
		flex-shrink: 1;
		min-width: 0;
	}

	.filter-label {
		max-width: clamp(60px, 25vw, 140px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sort-select {
		font-size: clamp(0.72rem, 2.4vw, 0.82rem);
		padding: clamp(3px, 1vw, 4px) clamp(4px, 1.5vw, 8px);
		border: 1px solid var(--color-border, #ddd);
		border-radius: 6px;
		background: var(--color-bg, #fff);
		color: var(--color-text, #111);
		flex-shrink: 1;
		min-width: 0;
	}

	.note-count {
		font-size: clamp(0.68rem, 2.2vw, 0.78rem);
		color: var(--color-text-secondary, #888);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.search-wrap {
		position: relative;
		margin-left: auto;
		flex: 1 1 auto;
		min-width: 80px;
		max-width: clamp(160px, 45vw, 280px);
		display: flex;
		align-items: center;
	}

	.search-icon {
		position: absolute;
		left: 8px;
		color: var(--color-text-secondary, #888);
		pointer-events: none;
	}

	.search-input {
		width: 100%;
		padding: clamp(4px, 1.2vw, 6px) 8px clamp(4px, 1.2vw, 6px) 26px;
		border: 1px solid var(--color-border, #ddd);
		border-radius: 16px;
		font-size: clamp(0.78rem, 2.6vw, 0.88rem);
		background: var(--color-bg-secondary, #f5f5f5);
		color: var(--color-text, #111);
		outline: none;
		min-width: 0;
	}

	.search-input:focus {
		border-color: var(--color-primary);
		background: var(--color-bg, #fff);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		z-index: 200;
	}

	.sheet {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		background: var(--color-bg, #fff);
		border-radius: 16px 16px 0 0;
		padding-bottom: calc(24px + var(--safe-area-bottom, 0px));
		z-index: 201;
		box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
		max-height: 70vh;
		display: flex;
		flex-direction: column;
	}

	.sheet-handle {
		width: 40px;
		height: 4px;
		background: #ccc;
		border-radius: 2px;
		margin: 12px auto 8px;
		flex-shrink: 0;
	}

	.sheet-title {
		padding: 0 20px 12px;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--color-text, #111);
		border-bottom: 1px solid var(--color-border, #eee);
		flex-shrink: 0;
	}

	.sheet-options {
		overflow-y: auto;
		flex: 1;
	}

	.sheet-option {
		display: block;
		width: 100%;
		padding: 14px 20px;
		font-size: 1rem;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: var(--color-text, #111);
	}

	.sheet-option:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.sheet-option.active {
		color: var(--color-primary, #1a73e8);
		font-weight: 600;
	}

	.list-container {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding-bottom: var(--safe-area-bottom);
	}

	.loading {
		padding: 24px;
		text-align: center;
		color: var(--color-text-secondary);
	}
</style>
