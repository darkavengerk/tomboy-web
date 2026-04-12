<script lang="ts">
	import { onMount } from 'svelte';
	import {
		isAuthenticated,
		downloadServerManifest,
		notesRootPath,
		type TomboyServerManifest
	} from '$lib/sync/dropboxClient.js';
	import { getManifest, type SyncManifest } from '$lib/sync/manifest.js';

	let authed = $state(false);
	let loading = $state(true);
	let server = $state<TomboyServerManifest | null>(null);
	let local = $state<SyncManifest | null>(null);
	let error = $state('');

	onMount(async () => {
		authed = isAuthenticated();
		if (!authed) {
			loading = false;
			return;
		}
		try {
			[server, local] = await Promise.all([downloadServerManifest(), getManifest()]);
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	});

	const localRevCount = $derived(local ? Object.keys(local.noteRevisions).length : 0);
	const serverIdMismatch = $derived(
		!!(local?.serverId && server?.serverId && local.serverId !== server.serverId)
	);
</script>

{#if !authed}
	<div class="notice">
		Dropbox에 먼저 연결해야 합니다. <a href="/settings">설정</a>으로 이동하세요.
	</div>
{:else if loading}
	<div class="notice">불러오는 중...</div>
{:else if error}
	<div class="notice error">오류: {error}</div>
{:else}
	<section class="cards">
		<div class="card">
			<div class="card-label">서버 리비전</div>
			<div class="card-value">{server?.revision ?? '—'}</div>
			<div class="card-sub">노트 {server?.notes.length ?? 0}개 추적 중</div>
		</div>
		<div class="card">
			<div class="card-label">로컬 마지막 동기화 rev</div>
			<div class="card-value">{local?.lastSyncRev ?? -1}</div>
			<div class="card-sub">
				{#if local?.lastSyncDate}
					{new Date(local.lastSyncDate).toLocaleString('ko-KR')}
				{:else}
					—
				{/if}
			</div>
		</div>
		<div class="card">
			<div class="card-label">로컬 추적 노트</div>
			<div class="card-value">{localRevCount}</div>
			<div class="card-sub">클라이언트가 서버 기준으로 아는 노트 수</div>
		</div>
		<div class="card" class:warn={serverIdMismatch}>
			<div class="card-label">server-id</div>
			<div class="card-value mono small">
				{(server?.serverId ?? '—').slice(0, 8)}…
			</div>
			<div class="card-sub">
				{#if serverIdMismatch}⚠ 로컬과 불일치{:else}일치{/if}
			</div>
		</div>
	</section>

	<section class="detail">
		<h2>경로</h2>
		<table>
			<tbody>
				<tr><th>notes root</th><td class="mono">{notesRootPath() || '/'}</td></tr>
				<tr><th>server-id (full)</th><td class="mono small">{server?.serverId ?? '—'}</td></tr>
				<tr><th>local server-id</th><td class="mono small">{local?.serverId || '—'}</td></tr>
			</tbody>
		</table>
	</section>

	<section class="detail">
		<h2>빠른 작업</h2>
		<ul class="actions">
			<li><a href="/admin/revisions">리비전 히스토리 보기 →</a></li>
			<li><a href="/admin/browse">Dropbox 파일 탐색 →</a></li>
			<li><a href="/admin/tools">백업 및 도구 →</a></li>
		</ul>
	</section>
{/if}

<style>
	.notice {
		padding: 20px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-radius: 8px;
		color: var(--color-text-secondary, #6b7280);
	}
	.notice.error { color: #b91c1c; background: #fef2f2; }
	.notice a { color: var(--color-primary, #2563eb); }

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 16px;
		margin-bottom: 32px;
	}
	.card {
		background: var(--color-bg-secondary, #f7f7f8);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 10px;
		padding: 16px;
	}
	.card.warn { border-color: #f59e0b; background: #fffbeb; }
	.card-label {
		font-size: 0.75rem;
		color: var(--color-text-secondary, #6b7280);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 6px;
	}
	.card-value {
		font-size: 1.8rem;
		font-weight: 600;
		line-height: 1.1;
	}
	.card-value.small { font-size: 1rem; }
	.card-sub {
		margin-top: 6px;
		font-size: 0.8rem;
		color: var(--color-text-secondary, #6b7280);
	}

	.detail {
		margin-bottom: 32px;
	}
	.detail h2 {
		font-size: 0.95rem;
		font-weight: 600;
		margin-bottom: 8px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	th, td {
		text-align: left;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border, #e5e7eb);
		vertical-align: top;
	}
	th {
		color: var(--color-text-secondary, #6b7280);
		font-weight: 500;
		width: 180px;
	}
	.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
	.small { font-size: 0.85rem; }

	.actions { list-style: none; padding: 0; margin: 0; }
	.actions li { padding: 8px 0; }
	.actions a {
		color: var(--color-primary, #2563eb);
		text-decoration: none;
	}
	.actions a:hover { text-decoration: underline; }
</style>
