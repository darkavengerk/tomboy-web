<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		isAuthenticated,
		downloadServerManifest,
		listRevisions,
		type TomboyServerManifest
	} from '$lib/sync/dropboxClient.js';
	import {
		downloadRevisionManifest,
		diffManifests,
		fetchNoteAtRevision,
		rollbackAndResync,
		type RevisionChangeSet
	} from '$lib/sync/adminClient.js';
	import { pushToast } from '$lib/stores/toast.js';
	import { diffLines, type Change } from 'diff';

	const rev = $derived(parseInt(page.params.rev ?? '0', 10));

	let authed = $state(false);
	let loading = $state(true);
	let error = $state('');

	let thisManifest = $state<TomboyServerManifest | null>(null);
	let prevRev = $state<number | null>(null);
	let prevManifest = $state<TomboyServerManifest | null>(null);
	let currentServerRev = $state<number | null>(null);
	let changes = $state<RevisionChangeSet | null>(null);

	// Per-note diff expansion state: guid → { loading, changes }
	type NoteDiff = { loading: boolean; changes?: Change[]; error?: string };
	let noteDiffs = $state<Map<string, NoteDiff>>(new Map());

	let rollbackConfirm = $state(false);
	let rollingBack = $state(false);

	$effect(() => {
		// reload when rev changes
		void rev;
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
		noteDiffs = new Map();
		try {
			const [rootManifest, revList, thisMan] = await Promise.all([
				downloadServerManifest(),
				listRevisions(),
				downloadRevisionManifest(rev)
			]);
			currentServerRev = rootManifest?.revision ?? null;
			thisManifest = thisMan;

			// Find immediate predecessor in the list
			const sorted = [...revList].sort((a, b) => a - b);
			const idx = sorted.indexOf(rev);
			prevRev = idx > 0 ? sorted[idx - 1] : null;
			prevManifest = prevRev !== null ? await downloadRevisionManifest(prevRev) : null;

			if (thisMan) changes = diffManifests(prevManifest, thisMan);
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	async function loadNoteDiff(guid: string, prevRevNum: number, thisRevNum: number) {
		const existing = noteDiffs.get(guid);
		if (existing && !existing.error) {
			// Toggle collapse by removing
			noteDiffs.delete(guid);
			noteDiffs = new Map(noteDiffs);
			return;
		}
		noteDiffs.set(guid, { loading: true });
		noteDiffs = new Map(noteDiffs);
		try {
			const [a, b] = await Promise.all([
				fetchNoteAtRevision(guid, prevRevNum),
				fetchNoteAtRevision(guid, thisRevNum)
			]);
			const aText = a ? buildNoteText(a.title, a.xmlContent) : '';
			const bText = b ? buildNoteText(b.title, b.xmlContent) : '';
			const d = diffLines(aText, bText);
			noteDiffs.set(guid, { loading: false, changes: d });
		} catch (e) {
			noteDiffs.set(guid, { loading: false, error: String(e) });
		}
		noteDiffs = new Map(noteDiffs);
	}

	async function loadNewNotePreview(guid: string, thisRevNum: number) {
		const existing = noteDiffs.get(guid);
		if (existing) {
			noteDiffs.delete(guid);
			noteDiffs = new Map(noteDiffs);
			return;
		}
		noteDiffs.set(guid, { loading: true });
		noteDiffs = new Map(noteDiffs);
		try {
			const n = await fetchNoteAtRevision(guid, thisRevNum);
			const text = n ? buildNoteText(n.title, n.xmlContent) : '';
			// Show as all-added pseudo-diff
			noteDiffs.set(guid, {
				loading: false,
				changes: [{ value: text, added: true, removed: false, count: 1 }]
			});
		} catch (e) {
			noteDiffs.set(guid, { loading: false, error: String(e) });
		}
		noteDiffs = new Map(noteDiffs);
	}

	function buildNoteText(title: string, xmlContent: string): string {
		// Strip the <note-content> wrapping and normalize for diff readability
		const inner = xmlContent
			.replace(/<note-content[^>]*>/, '')
			.replace(/<\/note-content>$/, '');
		return `# ${title}\n\n${inner}\n`;
	}

	async function handleRollback() {
		if (!rollbackConfirm) {
			rollbackConfirm = true;
			return;
		}
		rollingBack = true;
		try {
			const { newRev, syncResult } = await rollbackAndResync(rev);
			if (syncResult.status === 'success') {
				pushToast(`rev ${rev}로 롤백 완료 (새 rev ${newRev}, ${syncResult.downloaded}개 다운로드)`);
				await goto('/admin');
			} else {
				pushToast('롤백 후 재동기화 실패: ' + (syncResult.errors[0] ?? ''), { kind: 'error' });
			}
		} catch (e) {
			pushToast('롤백 실패: ' + String(e), { kind: 'error' });
		} finally {
			rollingBack = false;
			rollbackConfirm = false;
		}
	}

	const canRollback = $derived(
		currentServerRev !== null && rev < currentServerRev && thisManifest !== null
	);
</script>

<div class="header-row">
	<a href="/admin/revisions" class="back-link">← 전체 리비전</a>
	<h2 class="page-title">rev {rev}</h2>
	{#if currentServerRev === rev}
		<span class="badge current">현재 서버 리비전</span>
	{/if}
</div>

{#if !authed}
	<div class="notice">Dropbox 연결이 필요합니다.</div>
{:else if loading}
	<div class="notice">불러오는 중...</div>
{:else if error}
	<div class="notice error">오류: {error}</div>
{:else if !thisManifest}
	<div class="notice error">rev {rev} 매니페스트를 찾을 수 없습니다.</div>
{:else}
	<section class="summary">
		<table>
			<tbody>
				<tr><th>이 리비전</th><td>rev {rev} · 노트 {thisManifest.notes.length}개</td></tr>
				<tr>
					<th>이전 리비전</th>
					<td>
						{#if prevManifest && prevRev !== null}
							<a href={`/admin/revisions/${prevRev}`}>rev {prevRev}</a>
							· 노트 {prevManifest.notes.length}개
						{:else}
							— (최초 리비전)
						{/if}
					</td>
				</tr>
			</tbody>
		</table>
	</section>

	{#if canRollback}
		<section class="rollback-section">
			<h3>이 리비전으로 롤백</h3>
			<p class="info">
				현재 rev {currentServerRev}에서 rev {rev}의 상태로 되돌립니다.
				새 리비전 {((currentServerRev ?? 0) + 1)}을(를) 커밋하며, 이전 히스토리는 모두 서버에 보존됩니다.
				실행 직후 로컬이 초기화되고 서버에서 재동기화합니다.
			</p>
			<div class="actions">
				<button
					class="btn-danger"
					onclick={handleRollback}
					disabled={rollingBack}
				>
					{#if rollingBack}
						롤백 진행 중...
					{:else if rollbackConfirm}
						정말로 rev {rev}로 롤백? (다시 눌러 확인)
					{:else}
						rev {rev}로 롤백
					{/if}
				</button>
				{#if rollbackConfirm && !rollingBack}
					<button class="btn-secondary" onclick={() => (rollbackConfirm = false)}>취소</button>
				{/if}
			</div>
		</section>
	{/if}

	{#if changes}
		<section class="changes">
			<h3>변경 사항 (이전 대비)</h3>
			<p class="info">
				추가 {changes.added.length} · 수정 {changes.modified.length} · 삭제 {changes.removed.length}
			</p>

			{#if changes.added.length > 0}
				<details open>
					<summary>추가된 노트 ({changes.added.length})</summary>
					<ul class="change-list">
						{#each changes.added as c}
							<li>
								<button class="note-toggle added" onclick={() => loadNewNotePreview(c.guid, c.rev)}>
									<span class="change-icon">+</span>
									<span class="guid">{c.guid}</span>
									<span class="rev-tag">rev {c.rev}</span>
								</button>
								{@render diffBody(c.guid)}
							</li>
						{/each}
					</ul>
				</details>
			{/if}

			{#if changes.modified.length > 0}
				<details open>
					<summary>수정된 노트 ({changes.modified.length})</summary>
					<ul class="change-list">
						{#each changes.modified as c}
							<li>
								<button class="note-toggle modified" onclick={() => loadNoteDiff(c.guid, c.prevRev, c.rev)}>
									<span class="change-icon">~</span>
									<span class="guid">{c.guid}</span>
									<span class="rev-tag">rev {c.prevRev} → {c.rev}</span>
								</button>
								{@render diffBody(c.guid)}
							</li>
						{/each}
					</ul>
				</details>
			{/if}

			{#if changes.removed.length > 0}
				<details>
					<summary>삭제된 노트 ({changes.removed.length})</summary>
					<ul class="change-list">
						{#each changes.removed as c}
							<li class="removed-row">
								<span class="change-icon">−</span>
								<span class="guid">{c.guid}</span>
								<span class="rev-tag">마지막 rev {c.rev}</span>
								<a class="note-link" href={`/admin/notes/${c.guid}`}>히스토리 →</a>
							</li>
						{/each}
					</ul>
				</details>
			{/if}

			{#if changes.added.length === 0 && changes.modified.length === 0 && changes.removed.length === 0}
				<p class="info">변경 사항이 없습니다.</p>
			{/if}
		</section>
	{/if}
{/if}

{#snippet diffBody(guid: string)}
	{@const d = noteDiffs.get(guid)}
	{#if d}
		<div class="diff-box">
			{#if d.loading}
				<div class="diff-loading">diff 불러오는 중...</div>
			{:else if d.error}
				<div class="diff-error">{d.error}</div>
			{:else if d.changes}
				<pre class="diff-content">{#each d.changes as part}<span
					class:added={part.added}
					class:removed={part.removed}
					class:context={!part.added && !part.removed}
				>{part.value}</span>{/each}</pre>
				<a class="note-link" href={`/admin/notes/${guid}`}>이 노트의 전체 히스토리 →</a>
			{/if}
		</div>
	{/if}
{/snippet}

<style>
	.header-row {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-bottom: 16px;
	}
	.back-link {
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
		text-decoration: none;
	}
	.back-link:hover { text-decoration: underline; }
	.page-title {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.badge.current {
		font-size: 0.75rem;
		padding: 2px 8px;
		border-radius: 4px;
		background: #dbeafe;
		color: #1e40af;
	}

	.notice {
		padding: 20px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-radius: 8px;
		color: var(--color-text-secondary, #6b7280);
	}
	.notice.error { color: #b91c1c; background: #fef2f2; }

	.summary { margin-bottom: 24px; }
	table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
	th, td {
		text-align: left;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border, #e5e7eb);
	}
	th { color: var(--color-text-secondary, #6b7280); font-weight: 500; width: 160px; }
	td a { color: var(--color-primary, #2563eb); }

	.rollback-section {
		margin-bottom: 24px;
		padding: 16px;
		background: #fffbeb;
		border: 1px solid #fde68a;
		border-radius: 10px;
	}
	.rollback-section h3 { margin: 0 0 8px; font-size: 0.95rem; color: #92400e; }
	.info { font-size: 0.85rem; color: var(--color-text-secondary, #6b7280); margin-bottom: 12px; }
	.actions { display: flex; gap: 8px; }

	.btn-danger {
		background: #dc2626; color: white; border: none;
		padding: 10px 16px; border-radius: 6px; font-weight: 600; cursor: pointer;
	}
	.btn-danger:disabled { opacity: 0.6; cursor: not-allowed; }
	.btn-secondary {
		background: transparent; color: var(--color-text, #111);
		border: 1px solid var(--color-border, #e5e7eb);
		padding: 10px 16px; border-radius: 6px; cursor: pointer;
	}

	.changes h3 { font-size: 0.95rem; font-weight: 600; margin: 0 0 8px; }
	details {
		margin-bottom: 8px;
		background: var(--color-bg-secondary, #f7f7f8);
		border-radius: 8px;
		padding: 8px 12px;
	}
	summary { cursor: pointer; font-weight: 500; font-size: 0.9rem; padding: 4px 0; }

	.change-list { list-style: none; padding: 0; margin: 8px 0 0; }
	.change-list li { padding: 4px 0; }

	.note-toggle {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		background: transparent;
		border: none;
		padding: 4px 0;
		cursor: pointer;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		color: var(--color-text, #111);
		width: 100%;
		text-align: left;
	}
	.note-toggle:hover { color: var(--color-primary, #2563eb); }
	.change-icon { font-weight: 700; width: 14px; }
	.note-toggle.added .change-icon { color: #059669; }
	.note-toggle.modified .change-icon { color: #d97706; }
	.removed-row .change-icon { color: #dc2626; }
	.guid { flex: 1; font-size: 0.8rem; }
	.rev-tag {
		font-size: 0.75rem;
		color: var(--color-text-secondary, #6b7280);
		background: var(--color-bg, #fff);
		padding: 2px 6px;
		border-radius: 4px;
	}

	.removed-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
	}
	.note-link {
		font-size: 0.8rem;
		color: var(--color-primary, #2563eb);
		text-decoration: none;
	}
	.note-link:hover { text-decoration: underline; }

	.diff-box {
		margin-top: 6px;
		margin-left: 24px;
		background: var(--color-bg, #fff);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 6px;
		padding: 8px 10px;
	}
	.diff-loading, .diff-error {
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
		padding: 8px 0;
	}
	.diff-error { color: #b91c1c; }
	.diff-content {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
		line-height: 1.4;
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 360px;
		overflow-y: auto;
	}
	.diff-content .added { background: #d1fae5; color: #065f46; display: block; }
	.diff-content .removed { background: #fee2e2; color: #991b1b; display: block; }
	.diff-content .context { color: var(--color-text-secondary, #6b7280); }
</style>
