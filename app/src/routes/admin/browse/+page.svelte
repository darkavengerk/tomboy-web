<script lang="ts">
	import { onMount } from 'svelte';
	import {
		isAuthenticated,
		listFolder,
		downloadFileText,
		notesRootPath,
		type FolderEntry
	} from '$lib/sync/dropboxClient.js';

	let authed = $state(false);
	let currentPath = $state('');
	let entries = $state<FolderEntry[]>([]);
	let loading = $state(false);
	let error = $state('');

	let previewPath = $state<string | null>(null);
	let previewContent = $state('');
	let previewLoading = $state(false);

	onMount(() => {
		authed = isAuthenticated();
		if (!authed) return;
		currentPath = notesRootPath();
		void load(currentPath);
	});

	async function load(path: string) {
		loading = true;
		error = '';
		entries = [];
		try {
			entries = await listFolder(path);
			currentPath = path;
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	async function openFile(path: string) {
		previewPath = path;
		previewContent = '';
		previewLoading = true;
		try {
			previewContent = await downloadFileText(path);
		} catch (e) {
			previewContent = '오류: ' + String(e);
		} finally {
			previewLoading = false;
		}
	}

	function goUp() {
		const root = notesRootPath();
		if (currentPath === root) return;
		const parent = currentPath.replace(/\/[^/]+$/, '');
		load(parent || root || '');
	}

	function formatSize(bytes: number | undefined): string {
		if (bytes === undefined) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<h2 class="page-title">Dropbox 파일 탐색</h2>

{#if !authed}
	<div class="notice">Dropbox 연결이 필요합니다.</div>
{:else}
	<div class="path-bar">
		<button class="up-btn" onclick={goUp} disabled={currentPath === notesRootPath()}>↑ 상위</button>
		<code class="path">{currentPath || '/'}</code>
	</div>

	{#if error}
		<div class="notice error">오류: {error}</div>
	{:else if loading}
		<div class="notice">불러오는 중...</div>
	{:else if entries.length === 0}
		<div class="notice">비어 있습니다.</div>
	{:else}
		<div class="split">
			<div class="listing">
				<table>
					<thead>
						<tr>
							<th>이름</th>
							<th class="num">크기</th>
							<th>수정일</th>
						</tr>
					</thead>
					<tbody>
						{#each entries as e}
							<tr
								class:is-folder={e.kind === 'folder'}
								class:active={previewPath === e.path && e.kind === 'file'}
							>
								{#if e.kind === 'folder'}
									<td>
										<button class="row-btn" onclick={() => load(e.path)}>📁 {e.name}</button>
									</td>
									<td></td>
									<td></td>
								{:else}
									<td>
										<button class="row-btn" onclick={() => openFile(e.path)}>📄 {e.name}</button>
									</td>
									<td class="num">{formatSize(e.size)}</td>
									<td>{e.modified ? new Date(e.modified).toLocaleString('ko-KR') : ''}</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if previewPath}
				<aside class="preview">
					<div class="preview-header">
						<code class="preview-path">{previewPath}</code>
						<button class="close-btn" onclick={() => (previewPath = null)}>✕</button>
					</div>
					{#if previewLoading}
						<div class="muted">불러오는 중...</div>
					{:else}
						<pre>{previewContent}</pre>
					{/if}
				</aside>
			{/if}
		</div>
	{/if}
{/if}

<style>
	.page-title {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0 0 16px;
	}
	.path-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
	}
	.up-btn {
		background: var(--color-bg-secondary, #f7f7f8);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 6px;
		padding: 4px 10px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.up-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.path {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
	}

	.notice {
		padding: 20px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-radius: 8px;
		color: var(--color-text-secondary, #6b7280);
	}
	.notice.error { color: #b91c1c; background: #fef2f2; }

	.split {
		display: grid;
		grid-template-columns: minmax(280px, 1fr) minmax(360px, 2fr);
		gap: 16px;
	}
	.listing {
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		overflow: hidden;
		background: var(--color-bg, #fff);
	}
	table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
	th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--color-border, #e5e7eb); }
	th { font-weight: 500; color: var(--color-text-secondary, #6b7280); background: var(--color-bg-secondary, #f7f7f8); }
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
	tr:last-child td { border-bottom: none; }
	tr.active { background: #eff6ff; }
	.row-btn {
		background: transparent;
		border: none;
		padding: 0;
		cursor: pointer;
		font: inherit;
		color: var(--color-text, #111);
		text-align: left;
		width: 100%;
		font-family: inherit;
	}
	.row-btn:hover { color: var(--color-primary, #2563eb); }

	.preview {
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		background: var(--color-bg, #fff);
		overflow: hidden;
		display: flex;
		flex-direction: column;
		max-height: 70vh;
	}
	.preview-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 10px;
		border-bottom: 1px solid var(--color-border, #e5e7eb);
		background: var(--color-bg-secondary, #f7f7f8);
	}
	.preview-path {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		color: var(--color-text-secondary, #6b7280);
		word-break: break-all;
	}
	.close-btn {
		background: transparent;
		border: none;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 2px 6px;
	}
	.preview pre {
		margin: 0;
		padding: 12px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-y: auto;
		flex: 1;
	}
	.muted { padding: 12px; color: var(--color-text-secondary, #6b7280); font-size: 0.85rem; }
</style>
