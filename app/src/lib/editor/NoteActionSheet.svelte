<script lang="ts">
	import type { NoteData } from '$lib/core/note.js';

	export type ActionKind =
		| 'delete'
		| 'redownload'
		| 'editTitle'
		| 'toggleFavorite'
		| 'setHome'
		| 'unsetHome'
		| 'pickNotebook'
		| 'toggleScrollBottom'
		| 'compareWithServer'
		| 'viewXml';

	interface Props {
		note: NoteData;
		dirty: boolean;
		isFavoriteNote?: boolean;
		isHomeNote?: boolean;
		isScrollBottomNote?: boolean;
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
		onaction,
		onclose,
		onbacklinks
	}: Props = $props();

	let confirmDelete = $state(false);

	function handleBackdrop() {
		onclose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function openBacklinks() {
		onclose();
		onbacklinks?.();
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
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={handleBackdrop}></div>

<div class="sheet" role="dialog" aria-modal="true">
	<div class="sheet-handle"></div>

	<div class="sheet-title">{note.title || '제목 없음'}</div>
		<div class="sheet-actions">
			{#if !confirmDelete}
				<button class="action-btn" onclick={() => onaction('editTitle')}>
					<span class="action-icon">✎</span>
					제목 수정
				</button>
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
				<button class="action-btn" onclick={() => onaction('viewXml')}>
					<span class="action-icon">📄</span>
					원본 XML 보기
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
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		z-index: var(--z-sheet);
	}

	.sheet {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		background: var(--color-bg, #fff);
		border-radius: 16px 16px 0 0;
		padding: 12px 0 calc(24px + var(--safe-area-bottom, 0px));
		z-index: var(--z-sheet);
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
</style>
