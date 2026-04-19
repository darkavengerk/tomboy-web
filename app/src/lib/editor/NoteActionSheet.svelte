<script lang="ts">
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import type { NoteData } from '$lib/core/note.js';
	import { parseTomboyDate } from '$lib/core/note.js';

	export type ActionKind =
		| 'delete'
		| 'redownload'
		| 'toggleFavorite'
		| 'setHome'
		| 'unsetHome'
		| 'pickNotebook'
		| 'toggleScrollBottom'
		| 'compareWithServer';

	interface Props {
		note: NoteData;
		dirty: boolean;
		isFavoriteNote?: boolean;
		isHomeNote?: boolean;
		isScrollBottomNote?: boolean;
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
		onaction,
		onclose,
		ongoto
	}: Props = $props();

	type View = 'main' | 'backlinks';
	let view = $state<View>('main');
	let confirmDelete = $state(false);
	let backlinkNotes = $state<NoteData[]>([]);
	let backlinksLoading = $state(false);

	function handleBackdrop() {
		onclose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (view !== 'main') {
				view = 'main';
			} else {
				onclose();
			}
		}
	}

	function handleDelete() {
		if (confirmDelete) {
			onaction('delete');
		} else {
			confirmDelete = true;
		}
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

	function gotoBacklink(guid: string) {
		onclose();
		ongoto?.(guid);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={handleBackdrop}></div>

<div class="sheet" role="dialog" aria-modal="true">
	<div class="sheet-handle"></div>

	{#if view === 'main'}
		<div class="sheet-title">{note.title || '제목 없음'}</div>
		<div class="sheet-actions">
			{#if !confirmDelete}
				<button class="action-btn" onclick={() => onaction('pickNotebook')}>
					<span class="action-icon">🗂</span>
					노트북 이동
				</button>
				<button class="action-btn" onclick={() => onaction('toggleFavorite')}>
					<span class="action-icon">{isFavoriteNote ? '★' : '☆'}</span>
					{isFavoriteNote ? '즐겨찾기 해제' : '즐겨찾기'}
				</button>
				<button class="action-btn" onclick={() => onaction(isHomeNote ? 'unsetHome' : 'setHome')}>
					<span class="action-icon">🏠</span>
					{isHomeNote ? '홈 해제' : '홈으로 지정'}
				</button>
				<button class="action-btn" onclick={() => onaction('toggleScrollBottom')}>
					<span class="action-icon">⏬</span>
					{isScrollBottomNote ? '하단 최신 해제' : '하단이 최신'}
				</button>
				<button class="action-btn" onclick={openBacklinks}>
					<span class="action-icon">🔗</span>
					역참조
				</button>
				<button class="action-btn" onclick={handleRedownload} disabled={dirty}>
					<span class="action-icon">⬇</span>
					다시 다운받기
					{#if dirty}
						<span class="dirty-hint">(저장 중)</span>
					{/if}
				</button>
				<button class="action-btn" onclick={() => onaction('compareWithServer')}>
					<span class="action-icon">🔍</span>
					원본과 비교하기
				</button>
				<button class="action-btn danger" onclick={handleDelete}>
					<span class="action-icon">🗑</span>
					삭제
				</button>
			{:else}
				<p class="confirm-msg">정말 삭제하시겠습니까?</p>
				<button class="action-btn danger" onclick={handleDelete}>정말 삭제</button>
				<button class="action-btn" onclick={() => (confirmDelete = false)}>취소</button>
			{/if}
		</div>
	{:else}
		<div class="sheet-header-row">
			<button class="back-btn" onclick={() => (view = 'main')} aria-label="뒤로">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
					<polyline points="15 18 9 12 15 6" />
				</svg>
			</button>
			<span class="sheet-title-inline">역참조</span>
		</div>
		<div class="sheet-subtitle">{note.title || '제목 없음'}을(를) 링크하는 쪽지</div>
		<div class="backlinks-body">
			{#if backlinksLoading}
				<p class="backlinks-empty">검색 중...</p>
			{:else if backlinkNotes.length === 0}
				<p class="backlinks-empty">이 쪽지로 연결된 쪽지가 없습니다.</p>
			{:else}
				<ul class="backlinks-list">
					{#each backlinkNotes as n (n.guid)}
						<li>
							<button class="backlink-item" onclick={() => gotoBacklink(n.guid)}>
								<span class="backlink-title">{n.title || '제목 없음'}</span>
								<span class="backlink-date">{formatDate(n.changeDate)}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
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
		padding: 12px 0 calc(24px + var(--safe-area-bottom, 0px));
		z-index: 201;
		box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
	}

	.sheet-handle {
		width: 40px;
		height: 4px;
		background: #ccc;
		border-radius: 2px;
		margin: 0 auto 12px;
	}

	.sheet-title {
		padding: 0 20px 12px;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #666);
		border-bottom: 1px solid var(--color-border, #eee);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sheet-actions {
		display: flex;
		flex-direction: column;
	}

	.action-btn {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 20px;
		font-size: 1rem;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: var(--color-text, #111);
		width: 100%;
	}

	.action-btn:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.action-btn.danger {
		color: var(--color-danger, #c92a2a);
	}

	.action-icon {
		font-size: 1.2rem;
		width: 24px;
		text-align: center;
	}

	.dirty-hint {
		font-size: 0.75rem;
		color: var(--color-text-secondary, #666);
	}

	.confirm-msg {
		padding: 12px 20px;
		font-size: 0.95rem;
		color: var(--color-danger, #c92a2a);
	}

	.sheet-header-row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 0 12px 12px;
		border-bottom: 1px solid var(--color-border, #eee);
	}

	.back-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: none;
		background: none;
		border-radius: 50%;
		color: var(--color-text-secondary, #666);
		cursor: pointer;
		flex-shrink: 0;
	}

	.back-btn:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.sheet-title-inline {
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--color-text, #111);
	}

	.sheet-subtitle {
		padding: 6px 20px 8px;
		font-size: 0.78rem;
		color: var(--color-text-secondary, #888);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.backlinks-body {
		overflow-y: auto;
		max-height: 40vh;
	}

	.backlinks-empty {
		padding: 24px 20px;
		text-align: center;
		color: var(--color-text-secondary, #666);
		font-size: 0.9rem;
	}

	.backlinks-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.backlink-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 13px 20px;
		background: none;
		border: none;
		border-bottom: 1px solid var(--color-border, #eee);
		cursor: pointer;
		text-align: left;
		gap: 12px;
	}

	.backlink-item:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.backlink-title {
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--color-text, #111);
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.backlink-date {
		font-size: 0.78rem;
		color: var(--color-text-secondary, #666);
		flex-shrink: 0;
	}
</style>
