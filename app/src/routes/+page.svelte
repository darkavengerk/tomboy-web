<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { getHomeNoteGuid } from '$lib/core/home.js';
	import { createNote, listNotes } from '$lib/core/noteManager.js';

	let ready = $state(false);
	let hasNote = $state(false);

	onMount(async () => {
		const guid = await getHomeNoteGuid();
		if (guid) {
			goto(`/note/${guid}?from=home`, { replaceState: true });
			return;
		}
		const all = (await listNotes()).filter((n) => !n.deleted);
		if (all.length > 0) {
			const latest = [...all].sort((a, b) => (b.changeDate ?? '').localeCompare(a.changeDate ?? ''))[0];
			goto(`/note/${latest.guid}?from=home`, { replaceState: true });
			return;
		}
		hasNote = false;
		ready = true;
	});

	async function handleNewNote() {
		const n = await createNote();
		goto(`/note/${n.guid}`);
	}
</script>

<div class="home-page">
	<div class="content">
		{#if !ready}
			<div class="loading">로딩 중...</div>
		{:else if !hasNote}
			<div class="empty-state">
				<p class="empty-title">환영합니다</p>
				<p class="empty-hint">아직 노트가 없습니다.<br />새 노트를 만들어 보세요.</p>
				<button class="create-btn" onclick={handleNewNote}>새 노트 만들기</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.home-page {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.content {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px 20px;
	}

	.loading {
		color: var(--color-text-secondary);
	}

	.empty-state {
		text-align: center;
		color: var(--color-text-secondary);
	}

	.empty-title {
		font-size: 1.2rem;
		font-weight: 600;
		color: var(--color-text);
		margin-bottom: 8px;
	}

	.empty-hint {
		font-size: 0.9rem;
		line-height: 1.6;
		margin-bottom: 20px;
	}

	.create-btn {
		padding: 12px 24px;
		background: var(--color-primary);
		color: white;
		border: none;
		border-radius: 10px;
		font-size: 1rem;
		cursor: pointer;
	}
</style>
