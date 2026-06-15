<script lang="ts">
	import type { NoteData } from '$lib/core/note.js';
	import { portal } from '$lib/utils/portal.js';

	export type ActionKind =
		| 'delete'
		| 'editTitle'
		| 'reflectTitle'
		| 'redownload'
		| 'toggleFavorite'
		| 'setHome'
		| 'unsetHome'
		| 'toggleScrollBottom'
		| 'compareWithServer'
		| 'viewXml'
		| 'history';

	interface Props {
		note: NoteData;
		dirty: boolean;
		isFavoriteNote?: boolean;
		isHomeNote?: boolean;
		isScrollBottomNote?: boolean;
		anchor: { right: number; bottom: number };
		onaction: (kind: ActionKind) => void;
		onclose: () => void;
		/** 역참조 → 임시 묶음 노트 띄우기(호스트가 처리). */
		onbacklinks?: () => void;
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
		onbacklinks
	}: Props = $props();

	let confirmDelete = $state(false);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function handleDelete() {
		if (confirmDelete) onaction('delete');
		else confirmDelete = true;
	}

	function handleRedownload() {
		if (dirty) return;
		onaction('redownload');
	}

	function openBacklinks() {
		onclose();
		onbacklinks?.();
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
	{#if !confirmDelete}
			<button class="item" onclick={() => onaction('editTitle')}>
				<span class="icon">✎</span>제목 수정
			</button>
			{#if note.title.trim()}
				<button class="item" onclick={() => onaction('reflectTitle')}>
					<span class="icon">🌐</span>전체 문서에 이 제목 반영
				</button>
			{/if}
			<div class="sep"></div>
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
			<button class="item" onclick={() => onaction('viewXml')}>
				<span class="icon">📄</span>원본 XML 보기
			</button>
			<button class="item" onclick={() => onaction('history')}>
				<span class="icon">🕘</span>히스토리
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
</div>

<style>
	.ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-menu);
	}
	.ctx-menu {
		position: fixed;
		z-index: var(--z-menu);
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
</style>
