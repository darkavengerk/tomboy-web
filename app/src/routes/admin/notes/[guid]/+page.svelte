<script lang="ts">
	import { page } from '$app/state';
	import { isAuthenticated } from '$lib/sync/dropboxClient.js';
	import { fetchNoteAtRevision } from '$lib/sync/adminClient.js';
	import type { NoteData } from '$lib/core/note.js';
	import * as noteStore from '$lib/storage/noteStore.js';
	import { invalidateCache } from '$lib/stores/noteListCache.js';
	import {
		adminCache,
		initAdminCache,
		loadMoreRevs,
		ADMIN_PAGE_SIZE
	} from '$lib/stores/adminCache.svelte.js';
	import { pushToast } from '$lib/stores/toast.js';

	const guid = $derived(page.params.guid ?? '');

	let authed = $state(false);
	let loading = $state(true);
	let error = $state('');

	let loadedRevs = $state<Map<number, NoteData | null>>(new Map()); // noteRev → NoteData
	let expanded = $state<Set<number>>(new Set());

	$effect(() => {
		void guid;
		load();
	});

	async function load() {
		authed = isAuthenticated();
		if (!authed) {
			loading = false;
			return;
		}
		loading = true;
		error = '';
		loadedRevs = new Map();
		expanded = new Set();
		try {
			await initAdminCache();
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	/**
	 * Scan the admin-cache manifests for revs where this guid appears.
	 * We reuse whatever has already been loaded via the revisions list or
	 * rev-detail visits — no extra server calls to scan history.
	 */
	const entries = $derived.by(() => {
		const collected: Array<{ serverRev: number; noteRev: number }> = [];
		const seenNoteRevs = new Set<number>();
		const serverRevs = [...adminCache.manifestsByRev.keys()].sort((a, b) => b - a);
		for (const sr of serverRevs) {
			const m = adminCache.manifestsByRev.get(sr);
			if (!m) continue;
			const entry = m.notes.find((n) => n.guid === guid);
			if (!entry) continue;
			if (seenNoteRevs.has(entry.rev)) continue;
			seenNoteRevs.add(entry.rev);
			collected.push({ serverRev: sr, noteRev: entry.rev });
		}
		collected.sort((a, b) => b.noteRev - a.noteRev);
		return collected;
	});

	const scannedRevsCount = $derived(adminCache.manifestsByRev.size);

	async function togglePreview(noteRev: number) {
		if (expanded.has(noteRev)) {
			expanded.delete(noteRev);
			expanded = new Set(expanded);
			return;
		}
		expanded.add(noteRev);
		expanded = new Set(expanded);
		if (!loadedRevs.has(noteRev)) {
			try {
				const note = await fetchNoteAtRevision(guid, noteRev);
				loadedRevs.set(noteRev, note);
				loadedRevs = new Map(loadedRevs);
			} catch (e) {
				loadedRevs.set(noteRev, null);
				loadedRevs = new Map(loadedRevs);
				pushToast('노트를 불러올 수 없습니다: ' + String(e), { kind: 'error' });
			}
		}
	}

	let restoringRev = $state<number | null>(null);

	function formatDate(s: string): string {
		try {
			const d = (s && s.length > 0) ? new Date(s.replace(/\.(\d{3})\d{4}/, '.$1')) : null;
			return d && !isNaN(+d) ? d.toLocaleString('ko-KR') : s;
		} catch {
			return s;
		}
	}

	/**
	 * Restore this single note to the selected historical rev, overwriting the
	 * local copy and marking it as locally dirty so the next sync propagates it.
	 */
	async function restoreLocal(noteRev: number) {
		restoringRev = noteRev;
		try {
			const note = await fetchNoteAtRevision(guid, noteRev);
			if (!note) {
				pushToast('노트를 불러올 수 없습니다', { kind: 'error' });
				return;
			}
			note.guid = guid;
			note.localDirty = true;
			note.deleted = false;
			await noteStore.putNoteSynced(note);
			// localDirty=true tells the next sync to upload this as a new rev.
			// We leave the local manifest's noteRevisions[guid] untouched —
			// that's the last synced rev, which stays accurate.

			invalidateCache();
			pushToast(
				`이 노트를 rev ${noteRev} 상태로 복원했습니다. 다음 동기화에서 서버에 반영됩니다.`
			);
		} catch (e) {
			pushToast('복원 실패: ' + String(e), { kind: 'error' });
		} finally {
			restoringRev = null;
		}
	}
</script>

<div class="header-row">
	<a href="/admin/revisions" class="back-link">← 리비전</a>
	<h2 class="page-title">노트 히스토리</h2>
</div>
<p class="guid-label">guid: <code>{guid}</code></p>

{#if !authed}
	<div class="notice">Dropbox 연결이 필요합니다.</div>
{:else if loading}
	<div class="notice">히스토리를 모으는 중 (모든 리비전 매니페스트 스캔)...</div>
{:else if error}
	<div class="notice error">오류: {error}</div>
{:else}
	<p class="info">
		로드된 {scannedRevsCount}개 리비전 중 이 노트가 나타난 리비전:
		<strong>{entries.length}</strong>개
		{#if adminCache.hasMore}
			<span class="subtle">
				(리비전 페이지에서 더 로드하면 이 페이지의 히스토리도 늘어납니다)
			</span>
		{/if}
	</p>

	{#if adminCache.hasMore}
		<div class="load-more-row">
			<button class="btn-load-more" onclick={() => loadMoreRevs()} disabled={adminCache.loading}>
				{adminCache.loading ? '불러오는 중...' : `리비전 ${ADMIN_PAGE_SIZE}개 더 스캔`}
			</button>
		</div>
	{/if}

	{#if entries.length === 0}
		<div class="notice">로드된 리비전 범위 안에서는 이 노트를 찾지 못했습니다.</div>
	{:else}
	<ul class="history">
		{#each entries as e}
			{@const note = loadedRevs.get(e.noteRev)}
			{@const isOpen = expanded.has(e.noteRev)}
			<li class="entry">
				<button class="entry-header" onclick={() => togglePreview(e.noteRev)}>
					<span class="rev-label">note rev {e.noteRev}</span>
					<span class="server-rev">서버 rev {e.serverRev} 이후</span>
					<span class="chevron">{isOpen ? '▾' : '▸'}</span>
				</button>
				{#if isOpen}
					<div class="entry-body">
						{#if note === undefined}
							<div class="muted">불러오는 중...</div>
						{:else if note === null}
							<div class="muted error">노트 파일을 읽을 수 없습니다.</div>
						{:else}
							<table class="meta">
								<tbody>
									<tr><th>제목</th><td>{note.title}</td></tr>
									<tr><th>변경일</th><td>{formatDate(note.changeDate)}</td></tr>
									<tr><th>생성일</th><td>{formatDate(note.createDate)}</td></tr>
									{#if note.tags.length > 0}
										<tr><th>태그</th><td>{note.tags.join(', ')}</td></tr>
									{/if}
								</tbody>
							</table>
							<details>
								<summary>본문 미리보기 (XML)</summary>
								<pre class="xml">{note.xmlContent}</pre>
							</details>
							<div class="entry-actions">
								<button
									class="btn"
									onclick={() => restoreLocal(e.noteRev)}
									disabled={restoringRev !== null}
								>
									{restoringRev === e.noteRev ? '복원 중...' : '이 버전을 로컬에 복원'}
								</button>
								<span class="hint">
									* 복원 후 동기화하면 서버에 새 rev로 올라갑니다.
								</span>
							</div>
						{/if}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
	{/if}
{/if}

<style>
	.header-row {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-bottom: 8px;
	}
	.back-link {
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
		text-decoration: none;
	}
	.page-title {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
	}
	.guid-label {
		margin: 0 0 16px;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
	}
	.guid-label code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
	}

	.notice {
		padding: 20px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-radius: 8px;
		color: var(--color-text-secondary, #6b7280);
	}
	.notice.error { color: #b91c1c; background: #fef2f2; }

	.info {
		font-size: 0.9rem;
		color: var(--color-text-secondary, #6b7280);
		margin-bottom: 12px;
	}
	.subtle {
		font-size: 0.8rem;
		color: var(--color-text-secondary, #6b7280);
	}
	.load-more-row {
		margin-bottom: 16px;
	}
	.btn-load-more {
		background: var(--color-bg-secondary, #f7f7f8);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 6px;
		padding: 8px 14px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.btn-load-more:disabled { opacity: 0.6; cursor: not-allowed; }

	.history {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.entry {
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		background: var(--color-bg, #fff);
	}
	.entry-header {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		text-align: left;
		padding: 10px 14px;
		background: transparent;
		border: none;
		cursor: pointer;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9rem;
	}
	.entry-header:hover { background: var(--color-bg-secondary, #f7f7f8); }
	.rev-label { font-weight: 600; flex: 0 0 auto; }
	.server-rev {
		font-size: 0.8rem;
		color: var(--color-text-secondary, #6b7280);
		flex: 1;
	}
	.chevron { color: var(--color-text-secondary, #6b7280); }

	.entry-body {
		padding: 12px 14px 14px;
		border-top: 1px solid var(--color-border, #e5e7eb);
	}
	.meta { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 8px; }
	.meta th, .meta td { text-align: left; padding: 4px 8px; }
	.meta th {
		color: var(--color-text-secondary, #6b7280);
		font-weight: 500;
		width: 100px;
	}

	details { margin-top: 8px; }
	summary {
		cursor: pointer;
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
	}
	pre.xml {
		margin: 8px 0 0;
		padding: 10px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-radius: 6px;
		font-size: 0.75rem;
		max-height: 320px;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.entry-actions {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 12px;
		flex-wrap: wrap;
	}
	.btn {
		background: var(--color-primary, #2563eb);
		color: white;
		border: none;
		padding: 8px 14px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.btn:disabled { opacity: 0.6; cursor: not-allowed; }
	.hint {
		font-size: 0.75rem;
		color: var(--color-text-secondary, #6b7280);
	}
	.muted { color: var(--color-text-secondary, #6b7280); font-size: 0.85rem; }
	.muted.error { color: #b91c1c; }
</style>
