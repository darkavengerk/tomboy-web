<script lang="ts">
	import { onMount } from 'svelte';
	import { isAuthenticated } from '$lib/sync/dropboxClient.js';
	import {
		adminCache,
		initAdminCache,
		loadMoreRevs,
		ADMIN_PAGE_SIZE
	} from '$lib/stores/adminCache.svelte.js';

	let authed = $state(false);

	onMount(async () => {
		authed = isAuthenticated();
		if (authed) await initAdminCache();
	});

	const serverRev = $derived(adminCache.rootManifest?.revision ?? null);
	const displayed = $derived(adminCache.displayedRevs);

	async function refresh() {
		await initAdminCache(true);
	}
</script>

<div class="header-row">
	<h2 class="page-title">리비전 히스토리</h2>
	<button class="refresh-btn" onclick={refresh} disabled={adminCache.loading}>
		{adminCache.loading ? '작업 중...' : '처음부터 다시 로드'}
	</button>
</div>

{#if !authed}
	<div class="notice">Dropbox 연결이 필요합니다.</div>
{:else if !adminCache.initialized && adminCache.loading}
	<div class="notice">불러오는 중...</div>
{:else if adminCache.error}
	<div class="notice error">오류: {adminCache.error}</div>
{:else if displayed.length === 0 && !adminCache.loading}
	<div class="notice">아직 리비전이 없습니다.</div>
{:else}
	<p class="info">
		현재 서버 리비전 <strong>{serverRev ?? '—'}</strong>,
		로드된 리비전 <strong>{displayed.length}</strong>개
	</p>

	<ul class="rev-list">
		{#each displayed as rev}
			{@const m = adminCache.manifestsByRev.get(rev)}
			<li>
				<a href={`/admin/revisions/${rev}`} class="rev-link">
					<span class="rev-num">rev {rev}</span>
					<span class="note-count">
						{m ? `노트 ${m.notes.length}개` : '매니페스트 없음'}
					</span>
					{#if rev === serverRev}
						<span class="badge current">현재</span>
					{/if}
				</a>
			</li>
		{/each}
	</ul>

	{#if adminCache.hasMore}
		<div class="load-more-row">
			<button class="btn-load-more" onclick={() => loadMoreRevs()} disabled={adminCache.loading}>
				{adminCache.loading ? '불러오는 중...' : `${ADMIN_PAGE_SIZE}개 더 로드`}
			</button>
		</div>
	{:else if displayed.length > 0}
		<p class="end-note">모든 리비전이 로드되었습니다.</p>
	{/if}
{/if}

<style>
	.header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}
	.page-title {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0;
	}
	.refresh-btn {
		background: var(--color-bg-secondary, #f7f7f8);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 6px;
		padding: 6px 14px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.refresh-btn:disabled { opacity: 0.6; cursor: not-allowed; }

	.info {
		font-size: 0.9rem;
		color: var(--color-text-secondary, #6b7280);
		margin-bottom: 16px;
	}
	.notice {
		padding: 20px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-radius: 8px;
		color: var(--color-text-secondary, #6b7280);
	}
	.notice.error { color: #b91c1c; background: #fef2f2; }

	.rev-list {
		list-style: none;
		padding: 0;
		margin: 0 0 16px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.rev-link {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		text-decoration: none;
		color: var(--color-text, #111);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9rem;
		background: var(--color-bg, #fff);
	}
	.rev-link:hover { border-color: var(--color-primary, #2563eb); }
	.rev-num { font-weight: 600; flex: 0 0 auto; min-width: 80px; }
	.note-count {
		flex: 1;
		font-size: 0.8rem;
		color: var(--color-text-secondary, #6b7280);
	}
	.badge {
		font-size: 0.7rem;
		padding: 2px 6px;
		border-radius: 4px;
		font-family: inherit;
	}
	.badge.current { background: #dbeafe; color: #1e40af; }

	.load-more-row {
		display: flex;
		justify-content: center;
		margin-top: 8px;
	}
	.btn-load-more {
		background: var(--color-primary, #2563eb);
		color: white;
		border: none;
		padding: 10px 20px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.9rem;
	}
	.btn-load-more:disabled { opacity: 0.6; cursor: not-allowed; }
	.end-note {
		text-align: center;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
		margin-top: 16px;
	}
</style>
