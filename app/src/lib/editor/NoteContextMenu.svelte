<script lang="ts">
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import type { NoteData } from '$lib/core/note.js';
	import { parseTomboyDate } from '$lib/core/note.js';
	import { portal } from '$lib/utils/portal.js';

	export type ActionKind =
		| 'delete'
		| 'redownload'
		| 'toggleFavorite'
		| 'setHome'
		| 'unsetHome'
		| 'toggleScrollBottom'
		| 'compareWithServer';

	interface Props {
		note: NoteData;
		dirty: boolean;
		isFavoriteNote?: boolean;
		isHomeNote?: boolean;
		isScrollBottomNote?: boolean;
		anchor: { right: number; bottom: number };
		onaction: (kind: ActionKind) => void;
		onclose: () => void;
		ongoto?: (guid: string) => void;
	}

	let {
		note,
		dirty,
		isFavoriteNote = false,
		isHomeNote = false,
		isScrollBottomNote = false,
		anchor,
		onaction,
		onclose,
		ongoto
	}: Props = $props();

	type View = 'main' | 'backlinks';
	let view = $state<View>('main');
	let confirmDelete = $state(false);
	let backlinkNotes = $state<NoteData[]>([]);
	let backlinksLoading = $state(false);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (view !== 'main') view = 'main';
			else onclose();
		}
	}

	function handleDelete() {
		if (confirmDelete) onaction('delete');
		else confirmDelete = true;
	}

	function handleRedownload() {
		if (dirty) return;
		onaction('redownload');
	}

	async function openBacklinks() {
		view = 'backlinks';
		backlinksLoading = true;
		const titleKey = note.title.trim();
		const all = await getAllNotes();
		backlinkNotes = all.filter((n) => {
			if (n.guid === note.guid) return false;
			const xml = n.xmlContent;
			return (
				xml.includes(`>${titleKey}</link:internal>`) ||
				xml.includes(`>${titleKey}</link:broken>`)
			);
		});
		backlinksLoading = false;
	}

	function formatDate(s: string): string {
		if (!s) return '';
		const d = parseTomboyDate(s);
		const now = new Date();
		const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
		if (days === 0) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
		if (days < 7) return `${days}일 전`;
		return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
	}

	function gotoBacklink(guid: string) {
		onclose();
		ongoto?.(guid);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-backdrop" use:portal onclick={onclose}></div>

<div
	class="ctx-menu"
	use:portal
	style="right: {anchor.right}px; bottom: {anchor.bottom}px;"
	role="menu"
>
	{#if view === 'main'}
		{#if !confirmDelete}
			<button class="item" onclick={() => onaction('toggleFavorite')}>
				<span class="icon">{isFavoriteNote ? '★' : '☆'}</span>
				{isFavoriteNote ? '즐겨찾기 해제' : '즐겨찾기'}
			</button>
			<button class="item" onclick={() => onaction(isHomeNote ? 'unsetHome' : 'setHome')}>
				<span class="icon">🏠</span>
				{isHomeNote ? '홈 해제' : '홈으로 지정'}
			</button>
			<button class="item" onclick={() => onaction('toggleScrollBottom')}>
				<span class="icon">⏬</span>
				{isScrollBottomNote ? '하단 최신 해제' : '하단이 최신'}
			</button>
			<button class="item" onclick={openBacklinks}>
				<span class="icon">🔗</span>역참조
			</button>
			<div class="sep"></div>
			<button class="item" onclick={handleRedownload} disabled={dirty}>
				<span class="icon">⬇</span>다시 다운받기{#if dirty}<span class="hint">(저장 중)</span>{/if}
			</button>
			<button class="item" onclick={() => onaction('compareWithServer')}>
				<span class="icon">🔍</span>원본과 비교하기
			</button>
			<div class="sep"></div>
			<button class="item danger" onclick={handleDelete}>
				<span class="icon">🗑</span>삭제
			</button>
		{:else}
			<p class="confirm">정말 삭제하시겠습니까?</p>
			<button class="item danger" onclick={handleDelete}>정말 삭제</button>
			<button class="item" onclick={() => (confirmDelete = false)}>취소</button>
		{/if}
	{:else}
		<div class="header">
			<button class="back" onclick={() => (view = 'main')} aria-label="뒤로">‹</button>
			<span>역참조</span>
		</div>
		<div class="sub">{note.title || '제목 없음'}을(를) 링크하는 쪽지</div>
		<div class="backlinks">
			{#if backlinksLoading}
				<p class="empty">검색 중...</p>
			{:else if backlinkNotes.length === 0}
				<p class="empty">이 쪽지로 연결된 쪽지가 없습니다.</p>
			{:else}
				{#each backlinkNotes as n (n.guid)}
					<button class="backlink" onclick={() => gotoBacklink(n.guid)}>
						<span class="b-title">{n.title || '제목 없음'}</span>
						<span class="b-date">{formatDate(n.changeDate)}</span>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: 300;
	}
	.ctx-menu {
		position: fixed;
		z-index: 301;
		background: #fff;
		color: #111;
		border: 1px solid #d0d7de;
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
		min-width: 200px;
		padding: 4px;
		font-size: 0.85rem;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
		background: none;
		border: none;
		text-align: left;
		width: 100%;
		cursor: pointer;
		color: inherit;
		border-radius: 4px;
		font-size: inherit;
	}
	.item:hover:not(:disabled) {
		background: #f0f3f7;
	}
	.item:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.item.danger {
		color: #c92a2a;
	}
	.icon {
		width: 20px;
		text-align: center;
		font-size: 0.95rem;
	}
	.hint {
		margin-left: auto;
		font-size: 0.75rem;
		color: #666;
	}
	.sep {
		height: 1px;
		background: #e4e8ec;
		margin: 4px 2px;
	}
	.confirm {
		padding: 8px 10px;
		margin: 0;
		color: #c92a2a;
	}
	.header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border-bottom: 1px solid #e4e8ec;
		font-weight: 600;
	}
	.back {
		width: 24px;
		height: 24px;
		border: none;
		background: none;
		cursor: pointer;
		border-radius: 4px;
		font-size: 1.1rem;
	}
	.back:hover {
		background: #f0f3f7;
	}
	.sub {
		padding: 6px 10px;
		font-size: 0.78rem;
		color: #666;
	}
	.backlinks {
		max-height: 240px;
		overflow-y: auto;
	}
	.backlink {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		padding: 6px 10px;
		background: none;
		border: none;
		text-align: left;
		width: 100%;
		cursor: pointer;
		color: inherit;
	}
	.backlink:hover {
		background: #f0f3f7;
	}
	.b-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.85rem;
	}
	.b-date {
		flex-shrink: 0;
		color: #666;
		font-size: 0.75rem;
	}
	.empty {
		padding: 16px;
		text-align: center;
		color: #888;
	}
</style>
