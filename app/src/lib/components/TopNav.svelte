<script lang="ts">
	import { goto } from '$app/navigation';
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import { isFavorite, createNote } from '$lib/core/noteManager.js';
	import { parseTomboyDate } from '$lib/core/note.js';
	import type { NoteData } from '$lib/core/note.js';
	import { page } from '$app/state';
	import { appMode, type AppMode } from '$lib/stores/appMode.svelte.js';

	interface Props {
		canGoBack: boolean;
		canGoForward: boolean;
		onback?: () => void;
		onforward?: () => void;
	}

	let { canGoBack, canGoForward, onback, onforward }: Props = $props();

	const items: { href: string; label: string; mode: AppMode }[] = [
		{ href: '/', label: '홈', mode: 'home' },
		{ href: '/sleepnote', label: '슬립노트', mode: 'sleepnote' },
		{ href: '/notes', label: '전체', mode: 'notes' }
	];

	function handleNavClick(e: MouseEvent, mode: AppMode) {
		appMode.set(mode);
		// let the <a> navigate normally
		void e;
	}

	async function handleNewNote() {
		const n = await createNote();
		goto(`/note/${n.guid}`);
	}

	function isActive(mode: AppMode): boolean {
		return appMode.value === mode;
	}

	const themeClass = $derived(
		page.url.pathname === '/settings' ? 'theme-settings' : `theme-${appMode.value}`
	);

	// Favorites sheet state
	let showFavorites = $state(false);
	let favoriteNotes = $state<NoteData[]>([]);

	async function openFavorites() {
		const all = await getAllNotes();
		favoriteNotes = all.filter(isFavorite);
		showFavorites = true;
	}

	function closeFavorites() {
		showFavorites = false;
	}

	function handleSettings() {
		if (page.url.pathname === '/settings') {
			history.back();
		} else {
			goto('/settings');
		}
	}

	function openNote(guid: string) {
		closeFavorites();
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
</script>

<header class="topnav {themeClass}">
	<div class="nav-left">
		<button
			class="nav-btn"
			aria-label="뒤로가기"
			disabled={!canGoBack}
			onclick={onback}
		>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
				<polyline points="15 18 9 12 15 6" />
			</svg>
		</button>
		<button
			class="nav-btn"
			aria-label="앞으로가기"
			disabled={!canGoForward}
			onclick={onforward}
		>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
				<polyline points="9 18 15 12 9 6" />
			</svg>
		</button>
	</div>

	<nav class="nav-links" aria-label="주요 탐색">
		{#each items as item (item.href)}
			<a
				href={item.href}
				class="nav-link"
				class:active={isActive(item.mode)}
				aria-current={isActive(item.mode) ? 'page' : undefined}
				onclick={(e) => handleNavClick(e, item.mode)}
			>
				{item.label}
			</a>
		{/each}
	</nav>

	<div class="nav-spacer"></div>

	<div class="nav-right">
		<button class="nav-btn" aria-label="새 노트" onclick={handleNewNote}>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
				<line x1="12" y1="5" x2="12" y2="19" />
				<line x1="5" y1="12" x2="19" y2="12" />
			</svg>
		</button>
		<button class="nav-btn" aria-label="즐겨찾기" onclick={openFavorites}>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5">
				<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
			</svg>
		</button>
		<button class="nav-btn" aria-label="설정" onclick={handleSettings}>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
			</svg>
		</button>
	</div>
</header>

{#if showFavorites}
	<div
		class="sheet-backdrop"
		role="presentation"
		onclick={closeFavorites}
		onkeydown={(e) => e.key === 'Escape' && closeFavorites()}
	></div>
	<div class="sheet" role="dialog" aria-modal="true" aria-label="즐겨찾기">
		<div class="sheet-handle"></div>
		<div class="sheet-header">
			<span class="sheet-title">즐겨찾기</span>
			<button class="sheet-close" aria-label="닫기" onclick={closeFavorites}>✕</button>
		</div>
		<div class="sheet-body">
			{#if favoriteNotes.length === 0}
				<p class="sheet-empty">즐겨찾기한 노트가 없습니다.</p>
			{:else}
				<ul class="fav-list">
					{#each favoriteNotes as note (note.guid)}
						<li>
							<button class="fav-item" onclick={() => openNote(note.guid)}>
								<span class="fav-title">{note.title || '제목 없음'}</span>
								<span class="fav-date">{formatDate(note.changeDate)}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	.topnav {
		display: flex;
		align-items: center;
		gap: clamp(0px, 0.5vw, 4px);
		padding: 0 clamp(2px, 1.5vw, 8px);
		padding-top: var(--safe-area-top, 0px);
		height: calc(clamp(44px, 11vw, 52px) + var(--safe-area-top, 0px));
		background: var(--color-primary);
		color: white;
		flex-shrink: 0;
		transition: background 0.25s ease;
	}

	/* 모드별 테마 색상 */
	.theme-home     { background: #f57900; }
	.theme-sleepnote { background: #2563eb; }
	.theme-notes    { background: #6b7280; }
	.theme-settings { background: #b45309; }

	.nav-left {
		display: flex;
		gap: 0;
		flex-shrink: 0;
	}

	.nav-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: clamp(32px, 9vw, 40px);
		height: clamp(32px, 9vw, 40px);
		border: none;
		background: transparent;
		border-radius: 50%;
		color: white;
		cursor: pointer;
		text-decoration: none;
		flex-shrink: 0;
	}

	.nav-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.nav-btn:not(:disabled):active {
		background: rgba(255, 255, 255, 0.2);
	}

	.nav-links {
		display: flex;
		gap: clamp(0px, 0.5vw, 4px);
		margin-left: clamp(0px, 0.8vw, 4px);
		min-width: 0;
	}

	.nav-spacer {
		flex: 1;
	}

	.nav-link {
		padding: clamp(4px, 1.2vw, 6px) clamp(8px, 3vw, 14px);
		border-radius: 20px;
		font-size: clamp(0.78rem, 2.8vw, 0.9rem);
		font-weight: 500;
		color: rgba(255, 255, 255, 0.75);
		text-decoration: none;
		white-space: nowrap;
		transition: background 0.15s, color 0.15s;
	}

	.nav-link.active {
		background: rgba(255, 255, 255, 0.22);
		color: white;
		font-weight: 700;
	}

	.nav-link:not(.active):active {
		background: rgba(255, 255, 255, 0.12);
	}

	.nav-right {
		display: flex;
		gap: 0;
		flex-shrink: 0;
	}

	/* Favorites sheet */
	.sheet-backdrop {
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
		z-index: 201;
		max-height: 70vh;
		display: flex;
		flex-direction: column;
		padding-bottom: var(--safe-area-bottom, 0px);
		box-shadow: 0 -2px 20px rgba(0, 0, 0, 0.15);
	}

	.sheet-handle {
		width: 36px;
		height: 4px;
		background: var(--color-border, #ddd);
		border-radius: 2px;
		margin: 10px auto 0;
		flex-shrink: 0;
	}

	.sheet-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px 8px;
		flex-shrink: 0;
	}

	.sheet-title {
		font-size: 1rem;
		font-weight: 700;
		color: var(--color-text, #111);
	}

	.sheet-close {
		background: none;
		border: none;
		font-size: 1rem;
		color: var(--color-text-secondary, #666);
		cursor: pointer;
		padding: 4px 8px;
		border-radius: 4px;
	}

	.sheet-close:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.sheet-body {
		overflow-y: auto;
		flex: 1;
	}

	.sheet-empty {
		padding: 32px 16px;
		text-align: center;
		color: var(--color-text-secondary, #666);
		font-size: 0.9rem;
	}

	.fav-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.fav-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 14px 16px;
		background: none;
		border: none;
		border-bottom: 1px solid var(--color-border, #eee);
		cursor: pointer;
		text-align: left;
		gap: 12px;
	}

	.fav-item:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.fav-title {
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--color-text, #111);
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.fav-date {
		font-size: 0.8rem;
		color: var(--color-text-secondary, #666);
		flex-shrink: 0;
	}
</style>
