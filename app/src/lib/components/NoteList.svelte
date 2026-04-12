<script lang="ts">
	import { goto } from '$app/navigation';
	import type { NoteData } from '$lib/core/note.js';
	import { parseTomboyDate } from '$lib/core/note.js';
	import { sortForList, isFavorite } from '$lib/core/noteManager.js';
	import { getNotebook } from '$lib/core/notebooks.js';

	type SortKey = 'changeDate' | 'createDate';

	interface Props {
		notes: NoteData[];
		sortBy: SortKey;
	}

	let { notes, sortBy }: Props = $props();

	const sorted = $derived(sortForList(notes, sortBy));

	function openNote(guid: string) {
		goto(`/note/${guid}`);
	}

	function formatDate(dateStr: string): string {
		if (!dateStr) return '';
		const date = parseTomboyDate(dateStr);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));
		if (days === 0) return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
		if (days < 7) return `${days}일 전`;
		return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
	}

	function getPreview(note: NoteData): string {
		const match = note.xmlContent.match(/<note-content[^>]*>([\s\S]*?)<\/note-content>/);
		if (!match) return '';
		const text = match[1].replace(/<[^>]+>/g, '');
		const lines = text.split('\n');
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line.length > 0) return line.length > 80 ? line.substring(0, 80) + '...' : line;
		}
		return '';
	}
</script>

{#if sorted.length === 0}
	<p class="empty">노트가 없습니다.</p>
{:else}
	<ul class="note-list">
		{#each sorted as note (note.guid)}
			<li class="note-item">
				<div
					class="note-item-content"
					role="button"
					tabindex="0"
					onclick={() => openNote(note.guid)}
					onkeydown={(e) => e.key === 'Enter' && openNote(note.guid)}
				>
					<div class="note-title">
						{#if isFavorite(note)}<span class="pin-badge">⭐</span>{/if}
						{note.title || '제목 없음'}
					</div>
					<div class="note-meta">
						{#if getNotebook(note)}
							<span class="note-notebook">{getNotebook(note)}</span>
						{/if}
						<span class="note-date">{formatDate(note.changeDate)}</span>
					</div>
					<div class="note-preview">{getPreview(note)}</div>
				</div>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.note-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.note-item {
		border-bottom: 1px solid var(--color-border, #eee);
		background: var(--color-bg, #fff);
	}

	.note-item-content {
		padding: 12px 16px;
		cursor: pointer;
		display: block;
	}

	.note-item-content:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.note-title {
		font-size: 1rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pin-badge {
		font-size: 0.85rem;
		margin-right: 4px;
	}

	.note-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 2px;
		font-size: 0.8rem;
		color: var(--color-text-secondary, #666);
	}

	.note-notebook {
		background: #e8f0fe;
		color: #1a73e8;
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 0.75rem;
	}

	.note-preview {
		margin-top: 4px;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #666);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.empty {
		padding: 40px 20px;
		text-align: center;
		color: var(--color-text-secondary, #666);
	}
</style>
