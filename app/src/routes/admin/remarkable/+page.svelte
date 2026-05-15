<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listDiaryPages,
		requestRerun,
		cancelRerun,
		isScrollExtended,
		type DiaryPipelinePage
	} from '$lib/admin/remarkablePipeline.js';
	import { pushToast } from '$lib/stores/toast.js';

	let loading = $state(false);
	let pages = $state<DiaryPipelinePage[]>([]);
	let error = $state<string | null>(null);
	let pendingActions = $state<Set<string>>(new Set());

	async function load() {
		if (loading) return;
		loading = true;
		error = null;
		try {
			pages = await listDiaryPages();
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function onRerun(p: DiaryPipelinePage) {
		const next = new Set(pendingActions);
		next.add(p.pageUuid);
		pendingActions = next;
		try {
			await requestRerun(p.pageUuid);
			pushToast('재처리 요청됨. 데스크탑에서 s2 → s3 → s4를 다시 실행해 주세요.', {
				kind: 'info'
			});
			await load();
		} catch (e) {
			pushToast('재처리 요청 실패: ' + String(e), { kind: 'error' });
		} finally {
			const after = new Set(pendingActions);
			after.delete(p.pageUuid);
			pendingActions = after;
		}
	}

	async function onCancel(p: DiaryPipelinePage) {
		const next = new Set(pendingActions);
		next.add(p.pageUuid);
		pendingActions = next;
		try {
			await cancelRerun(p.pageUuid);
			pushToast('재처리 요청 취소', { kind: 'info' });
			await load();
		} catch (e) {
			pushToast('취소 실패: ' + String(e), { kind: 'error' });
		} finally {
			const after = new Set(pendingActions);
			after.delete(p.pageUuid);
			pendingActions = after;
		}
	}

	function formatDate(p: DiaryPipelinePage): string {
		const ms = p.lastModifiedMs ?? (p.writtenAt ? Date.parse(p.writtenAt) : NaN);
		if (!Number.isFinite(ms)) return '—';
		const d = new Date(ms as number);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	function formatDims(p: DiaryPipelinePage): string {
		if (p.imageWidth && p.imageHeight) {
			return `${p.imageWidth} × ${p.imageHeight}`;
		}
		return '—';
	}

	function shortUuid(u: string): string {
		return u.length > 8 ? u.slice(0, 8) + '…' : u;
	}

	async function copyUuid(u: string) {
		try {
			await navigator.clipboard.writeText(u);
			pushToast(`UUID 복사: ${u}`, { kind: 'info' });
		} catch {
			pushToast('복사 실패', { kind: 'error' });
		}
	}

	const totals = $derived({
		total: pages.length,
		pending: pages.filter((p) => p.rerunRequested).length,
		scrolled: pages.filter(isScrollExtended).length
	});
</script>

<div class="header-row">
	<h2 class="page-title">리마커블 일기 파이프라인</h2>
	<button class="btn" onclick={load} disabled={loading}>
		{loading ? '불러오는 중...' : '새로고침'}
	</button>
</div>

<p class="intro">
	데스크탑 OCR 파이프라인이 Firestore에 기록한 페이지별 상태를 보여줍니다. 페이지별 "재처리 요청"을 누르면
	플래그가 설정되고, 데스크탑에서 다음번 <code>s2_prepare → s3_ocr → s4_write</code>를 실행할 때 해당
	페이지가 강제로 다시 처리됩니다. 처음 OCR된 후 화면 높이 (1872 픽셀) 를 넘는 페이지는 사용자가 리마커블에서
	스크롤하며 작성한 페이지로, 동적 캔버스 렌더러가 전체 영역을 캡쳐한 것입니다.
</p>

{#if error}
	<div class="notice error">불러오기 실패: {error}</div>
{/if}

{#if pages.length > 0}
	<section class="cards">
		<div class="card">
			<div class="card-label">처리된 페이지</div>
			<div class="card-value">{totals.total}</div>
		</div>
		<div class="card" class:warn={totals.pending > 0}>
			<div class="card-label">재처리 대기</div>
			<div class="card-value">{totals.pending}</div>
		</div>
		<div class="card">
			<div class="card-label">스크롤 페이지</div>
			<div class="card-value">{totals.scrolled}</div>
		</div>
	</section>
{/if}

{#if !loading && pages.length === 0 && !error}
	<div class="notice info">
		아직 표시할 데이터가 없습니다. 데스크탑에서 <code>python -m desktop.stages.s4_write</code>를 한 번 실행하면
		기존에 처리된 페이지의 상태 문서가 백필됩니다.
	</div>
{/if}

{#if pages.length > 0}
	<section class="block">
		<table class="page-table">
			<thead>
				<tr>
					<th>날짜</th>
					<th>페이지 UUID</th>
					<th>이미지</th>
					<th>치수</th>
					<th>OCR</th>
					<th>노트</th>
					<th>액션</th>
				</tr>
			</thead>
			<tbody>
				{#each pages as p (p.pageUuid)}
					{@const busy = pendingActions.has(p.pageUuid)}
					{@const scroll = isScrollExtended(p)}
					<tr class:pending={p.rerunRequested}>
						<td class="date">{formatDate(p)}</td>
						<td>
							<button
								class="uuid-chip"
								type="button"
								title="클릭해서 UUID 복사"
								onclick={() => copyUuid(p.pageUuid)}>{shortUuid(p.pageUuid)}</button
							>
						</td>
						<td>
							{#if p.imageUrl}
								<a class="thumb" href={p.imageUrl} target="_blank" rel="noreferrer">
									<img src={p.imageUrl} alt="page" loading="lazy" />
								</a>
							{:else}
								—
							{/if}
						</td>
						<td>
							<span class="dims">{formatDims(p)}</span>
							{#if scroll}<span class="badge scroll">스크롤</span>{/if}
						</td>
						<td class="ocr-cell">
							{#if p.ocrCharCount != null}
								<div>{p.ocrCharCount} 자</div>
							{/if}
							{#if p.ocrAt}
								<div class="muted">{p.ocrAt.slice(0, 19)}</div>
							{/if}
							{#if p.ocrModel}
								<div class="muted small">{p.ocrModel}</div>
							{/if}
						</td>
						<td>
							{#if p.tomboyGuid}
								<a href={'/note/' + p.tomboyGuid} class="note-link">열기</a>
							{:else}
								—
							{/if}
						</td>
						<td class="action-cell">
							{#if p.rerunRequested}
								<span class="badge pending-badge">대기 중</span>
								<button class="btn-sm subtle" disabled={busy} onclick={() => onCancel(p)}
									>취소</button
								>
							{:else}
								<button class="btn-sm" disabled={busy} onclick={() => onRerun(p)}>재처리 요청</button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
{/if}

<style>
	.header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
	}
	.page-title {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0;
	}
	.intro {
		font-size: 0.85rem;
		color: var(--color-text-secondary, #6b7280);
		line-height: 1.5;
		margin: 0 0 14px;
	}
	.intro code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: var(--color-bg-secondary, #f3f4f6);
		padding: 0 4px;
		border-radius: 3px;
	}

	.btn {
		background: var(--color-primary, #2563eb);
		color: white;
		border: none;
		padding: 8px 16px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 500;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-sm {
		background: var(--color-primary, #2563eb);
		color: white;
		border: none;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
	}
	.btn-sm:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.btn-sm.subtle {
		background: transparent;
		color: var(--color-text-secondary, #6b7280);
		border: 1px solid var(--color-border, #e5e7eb);
		margin-left: 6px;
	}

	.notice {
		padding: 14px 16px;
		border-radius: 8px;
		font-size: 0.9rem;
		margin-bottom: 16px;
	}
	.notice.info {
		background: #eff6ff;
		color: #1e3a8a;
		border: 1px solid #bfdbfe;
	}
	.notice.error {
		background: #fef2f2;
		color: #b91c1c;
		border: 1px solid #fecaca;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 12px;
		margin-bottom: 20px;
	}
	.card {
		background: var(--color-bg-secondary, #f7f7f8);
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 10px;
		padding: 14px;
	}
	.card.warn {
		border-color: #f59e0b;
		background: #fffbeb;
	}
	.card-label {
		font-size: 0.72rem;
		color: var(--color-text-secondary, #6b7280);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 4px;
	}
	.card-value {
		font-size: 1.6rem;
		font-weight: 600;
		line-height: 1.1;
	}

	.block {
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		overflow: hidden;
	}

	.page-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.page-table th,
	.page-table td {
		text-align: left;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border, #e5e7eb);
		vertical-align: middle;
	}
	.page-table th {
		background: var(--color-bg-secondary, #f7f7f8);
		font-weight: 500;
		color: var(--color-text-secondary, #6b7280);
		font-size: 0.75rem;
	}
	.page-table tr.pending {
		background: #fffbeb;
	}
	.page-table tr:last-child td {
		border-bottom: none;
	}

	.date {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
		white-space: nowrap;
	}

	.uuid-chip {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		background: var(--color-bg-secondary, #f3f4f6);
		border: 1px solid var(--color-border, #e5e7eb);
		color: var(--color-text-secondary, #4b5563);
		padding: 2px 6px;
		border-radius: 4px;
		cursor: pointer;
	}
	.uuid-chip:hover {
		background: #e0e7ff;
		color: #3730a3;
		border-color: #c7d2fe;
	}

	.thumb {
		display: inline-block;
		width: 60px;
		height: 78px;
		overflow: hidden;
		border-radius: 4px;
		border: 1px solid var(--color-border, #e5e7eb);
		background: white;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top;
		display: block;
	}

	.dims {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
	}

	.badge {
		display: inline-block;
		font-size: 0.65rem;
		padding: 1px 6px;
		border-radius: 999px;
		margin-left: 6px;
		vertical-align: middle;
	}
	.badge.scroll {
		background: #ede9fe;
		color: #5b21b6;
	}
	.badge.pending-badge {
		background: #fde68a;
		color: #92400e;
	}

	.ocr-cell {
		min-width: 130px;
	}
	.ocr-cell .muted {
		font-size: 0.72rem;
		color: var(--color-text-secondary, #6b7280);
	}
	.ocr-cell .small {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
	}

	.note-link {
		color: var(--color-primary, #2563eb);
		text-decoration: none;
	}
	.note-link:hover {
		text-decoration: underline;
	}

	.action-cell {
		white-space: nowrap;
	}
</style>
