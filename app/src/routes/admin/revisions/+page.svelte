<script lang="ts">
	import { onMount } from 'svelte';
	import {
		isAuthenticated,
		listRevisions,
		downloadServerManifest
	} from '$lib/sync/dropboxClient.js';

	let authed = $state(false);
	let loading = $state(true);
	let revs = $state<number[]>([]);
	let serverRev = $state<number | null>(null);
	let error = $state('');

	onMount(async () => {
		authed = isAuthenticated();
		if (!authed) {
			loading = false;
			return;
		}
		try {
			const [list, manifest] = await Promise.all([listRevisions(), downloadServerManifest()]);
			revs = list;
			serverRev = manifest?.revision ?? null;
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	});
</script>

<h2 class="page-title">리비전 히스토리</h2>

{#if !authed}
	<div class="notice">Dropbox 연결이 필요합니다.</div>
{:else if loading}
	<div class="notice">리비전 목록을 불러오는 중...</div>
{:else if error}
	<div class="notice error">오류: {error}</div>
{:else if revs.length === 0}
	<div class="notice">아직 리비전이 없습니다.</div>
{:else}
	<p class="info">
		총 <strong>{revs.length}</strong>개 리비전. 현재 서버 리비전:
		<strong>{serverRev}</strong>
	</p>
	<ul class="rev-list">
		{#each revs as rev}
			<li>
				<a href={`/admin/revisions/${rev}`} class="rev-link">
					<span class="rev-num">rev {rev}</span>
					{#if rev === serverRev}
						<span class="badge current">현재</span>
					{/if}
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.page-title {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0 0 16px;
	}
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
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 8px;
	}
	.rev-link {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		text-decoration: none;
		color: var(--color-text, #111);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9rem;
		background: var(--color-bg, #fff);
	}
	.rev-link:hover {
		border-color: var(--color-primary, #2563eb);
	}
	.rev-num { font-weight: 500; }
	.badge {
		font-size: 0.7rem;
		padding: 2px 6px;
		border-radius: 4px;
		font-family: inherit;
	}
	.badge.current { background: #dbeafe; color: #1e40af; }
</style>
