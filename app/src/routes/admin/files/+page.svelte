<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listBridgeFiles,
		deleteBridgeFile,
		type BridgeFileMeta
	} from '$lib/sync/bridgeFileAdmin.js';
	import {
		getDefaultTerminalBridge,
		bridgeToHttpBase
	} from '$lib/editor/terminal/bridgeSettings.js';
	import { pushToast } from '$lib/stores/toast.js';

	let files = $state<BridgeFileMeta[] | null>(null);
	let loading = $state(false);
	let error = $state('');
	let busyUuid = $state<string | null>(null);
	let query = $state('');

	const filtered = $derived.by(() => {
		const source = files ?? [];
		const sorted = [...source].sort((a, b) => b.mtime.localeCompare(a.mtime));
		const q = query.trim().toLowerCase();
		if (!q) return sorted;
		return sorted.filter((f) => f.filename.toLowerCase().includes(q));
	});

	const totalBytes = $derived.by(() => {
		return (files ?? []).reduce((acc, f) => acc + (f.size ?? 0), 0);
	});

	async function refresh() {
		loading = true;
		error = '';
		try {
			files = await listBridgeFiles();
		} catch (err) {
			error = (err as Error).message;
			files = null;
		} finally {
			loading = false;
		}
	}

	onMount(refresh);

	async function openDownload(uuid: string, filename: string) {
		try {
			const bridge = await getDefaultTerminalBridge();
			if (!bridge) {
				pushToast('브릿지 설정이 필요합니다.', { kind: 'error' });
				return;
			}
			const base = bridgeToHttpBase(bridge).replace(/\/$/, '');
			const url = `${base}/files/${encodeURIComponent(uuid)}/${encodeURIComponent(filename)}`;
			window.open(url, '_blank', 'noopener,noreferrer');
		} catch (err) {
			pushToast(`다운로드 URL 생성 실패: ${(err as Error).message}`, { kind: 'error' });
		}
	}

	async function remove(file: BridgeFileMeta) {
		if (busyUuid) return;
		const ok = window.confirm(
			`"${file.filename}" 파일을 삭제할까요?\n노트에서 참조 중이면 링크가 깨집니다.`
		);
		if (!ok) return;
		busyUuid = file.uuid;
		try {
			await deleteBridgeFile(file.uuid);
			pushToast('파일을 삭제했어요.');
		} catch (err) {
			pushToast(`삭제 실패: ${(err as Error).message}`, { kind: 'error' });
		} finally {
			busyUuid = null;
			await refresh();
		}
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	function formatMtime(iso: string): string {
		try {
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return iso;
			return d.toLocaleString('ko-KR', {
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit'
			});
		} catch {
			return iso;
		}
	}
</script>

<section class="page">
	<header>
		<h2>브릿지 파일</h2>
		<button onclick={refresh} disabled={loading}>
			{loading ? '로딩 중…' : '새로고침'}
		</button>
	</header>

	{#if error}
		<div class="banner warn">⚠️ 목록을 가져오지 못했습니다: {error}</div>
	{/if}

	{#if files !== null}
		<div class="summary">
			총 {files.length}개 · {formatSize(totalBytes)}
		</div>
		<div class="filter-bar">
			<input
				type="search"
				placeholder="파일 이름 검색"
				bind:value={query}
			/>
		</div>
	{/if}

	{#if files !== null && files.length === 0}
		<p class="empty">파일이 없습니다.</p>
	{:else if files !== null && filtered.length === 0}
		<p class="empty">검색 결과가 없습니다.</p>
	{:else if files !== null}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>파일 이름</th>
						<th class="num">크기</th>
						<th>수정일</th>
						<th class="uuid-col">UUID</th>
						<th class="actions-col">동작</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as f (f.uuid)}
						<tr class:busy={busyUuid === f.uuid}>
							<td class="filename">{f.filename}</td>
							<td class="num">{formatSize(f.size)}</td>
							<td>{formatMtime(f.mtime)}</td>
							<td class="uuid"><code>{f.uuid.slice(0, 8)}</code></td>
							<td class="actions">
								<button
									onclick={() => openDownload(f.uuid, f.filename)}
									disabled={busyUuid !== null}
								>
									다운로드
								</button>
								<button
									class="danger"
									onclick={() => remove(f)}
									disabled={busyUuid !== null}
								>
									삭제
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	header h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	header button {
		padding: 6px 12px;
		font-size: 0.85rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
	}
	header button:hover:not(:disabled) {
		background: #f9fafb;
	}
	header button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.banner.warn {
		padding: 10px 14px;
		background: #fff7e0;
		border: 1px solid #f0c674;
		border-radius: 6px;
		font-size: 0.85rem;
	}
	.summary {
		color: #6b7280;
		font-size: 0.85rem;
	}
	.filter-bar {
		display: flex;
		gap: 8px;
	}
	.filter-bar input {
		flex: 1;
		padding: 6px 10px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-size: 0.85rem;
	}
	.empty {
		color: #6b7280;
		font-size: 0.9rem;
	}
	.table-wrap {
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		overflow: hidden;
		background: #fff;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	thead {
		background: #f9fafb;
	}
	th,
	td {
		text-align: left;
		padding: 8px 12px;
		border-bottom: 1px solid #f3f4f6;
	}
	th {
		font-weight: 600;
		color: #374151;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	tbody tr:last-child td {
		border-bottom: none;
	}
	tbody tr.busy {
		opacity: 0.6;
	}
	td.num,
	th.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.filename {
		font-weight: 500;
		color: #111827;
	}
	.uuid code {
		color: #6b7280;
		font-size: 0.75rem;
	}
	.actions-col {
		width: 1%;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		gap: 6px;
	}
	.actions button {
		padding: 4px 10px;
		font-size: 0.75rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
	}
	.actions button:hover:not(:disabled) {
		background: #f9fafb;
	}
	.actions button.danger {
		color: #dc2626;
		border-color: #fca5a5;
	}
	.actions button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
