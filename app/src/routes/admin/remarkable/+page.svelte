<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listDiaryPages,
		requestRerun,
		cancelRerun,
		isScrollExtended,
		triggerPipelineRun,
		fetchTriggerStatus,
		pingTrigger,
		type DiaryPipelinePage,
		type TriggerStatus
	} from '$lib/admin/remarkablePipeline.js';
	import {
		getDiaryTriggerUrl,
		setDiaryTriggerUrl,
		getDiaryTriggerToken,
		setDiaryTriggerToken
	} from '$lib/storage/appSettings.js';
	import { pushToast } from '$lib/stores/toast.js';

	let loading = $state(false);
	let pages = $state<DiaryPipelinePage[]>([]);
	let error = $state<string | null>(null);
	let pendingActions = $state<Set<string>>(new Set());

	// Trigger settings (loaded from appSettings, saved on user save).
	let triggerUrl = $state('');
	let triggerToken = $state('');
	let triggerUrlInput = $state('');
	let triggerTokenInput = $state('');
	let savingSettings = $state(false);
	let triggerHealth = $state<'unknown' | 'ok' | 'down'>('unknown');
	let triggerStatus = $state<TriggerStatus | null>(null);
	let triggerActionBusy = $state(false);

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

	async function loadSettings() {
		triggerUrl = await getDiaryTriggerUrl();
		triggerToken = await getDiaryTriggerToken();
		triggerUrlInput = triggerUrl;
		triggerTokenInput = triggerToken;
		if (triggerUrl) {
			refreshTriggerHealth();
			refreshTriggerStatus();
		}
	}

	async function saveSettings() {
		if (savingSettings) return;
		savingSettings = true;
		try {
			await setDiaryTriggerUrl(triggerUrlInput.trim());
			await setDiaryTriggerToken(triggerTokenInput.trim());
			triggerUrl = triggerUrlInput.trim();
			triggerToken = triggerTokenInput.trim();
			pushToast('트리거 설정 저장됨', { kind: 'info' });
			refreshTriggerHealth();
			refreshTriggerStatus();
		} catch (e) {
			pushToast('저장 실패: ' + String(e), { kind: 'error' });
		} finally {
			savingSettings = false;
		}
	}

	async function refreshTriggerHealth() {
		if (!triggerUrl) {
			triggerHealth = 'unknown';
			return;
		}
		triggerHealth = (await pingTrigger(triggerUrl)) ? 'ok' : 'down';
	}

	async function refreshTriggerStatus() {
		if (!triggerUrl || !triggerToken) {
			triggerStatus = null;
			return;
		}
		const r = await fetchTriggerStatus(triggerUrl, triggerToken);
		triggerStatus = r.ok && r.status ? r.status : null;
	}

	async function fireTrigger(): Promise<boolean> {
		const r = await triggerPipelineRun(triggerUrl, triggerToken);
		if (r.ok && r.started) {
			triggerStatus = r.status ?? null;
			return true;
		}
		if (r.ok && r.alreadyRunning) {
			triggerStatus = r.status ?? null;
			pushToast('이미 실행 중입니다 — 기존 잡이 완료된 뒤 큐의 모든 페이지가 처리됩니다.', {
				kind: 'info'
			});
			return true;
		}
		pushToast('트리거 실패: ' + (r.error ?? 'unknown'), { kind: 'error' });
		return false;
	}

	async function runTriggerNow() {
		if (!triggerUrl || !triggerToken) {
			pushToast('먼저 트리거 URL과 토큰을 저장해 주세요', { kind: 'error' });
			return;
		}
		if (triggerActionBusy) return;
		triggerActionBusy = true;
		try {
			const ok = await fireTrigger();
			if (ok) pushToast('파이프라인 실행 시작', { kind: 'info' });
		} finally {
			triggerActionBusy = false;
		}
		setTimeout(refreshTriggerStatus, 1500);
	}

	onMount(async () => {
		await loadSettings();
		await load();
	});

	async function onRerun(p: DiaryPipelinePage) {
		const next = new Set(pendingActions);
		next.add(p.pageUuid);
		pendingActions = next;
		try {
			await requestRerun(p.pageUuid);
			// If a trigger URL is configured, kick the desktop NOW so the
			// user doesn't have to run the pipeline by hand. Falls back
			// silently if not configured — the Firestore flag alone is
			// still useful for the manual-run flow.
			if (triggerUrl && triggerToken) {
				const ok = await fireTrigger();
				if (ok) {
					pushToast('재처리 요청 + 데스크탑 트리거 발송', { kind: 'info' });
				} else {
					pushToast('재처리는 큐에 등록됨. 데스크탑 트리거 발송은 실패.', { kind: 'info' });
				}
				setTimeout(refreshTriggerStatus, 1500);
			} else {
				pushToast('재처리 요청됨. 데스크탑에서 s2 → s3 → s4를 다시 실행해 주세요.', {
					kind: 'info'
				});
			}
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
	플래그가 설정되고, 트리거 URL이 설정돼 있으면 즉시 데스크탑에 신호를 보내 자동으로 실행됩니다. 트리거 URL이
	비어 있으면 다음번 수동 <code>s2_prepare → s3_ocr → s4_write</code> 실행 때 해당 페이지가 강제로 다시
	처리됩니다.
</p>

<section class="trigger-panel">
	<div class="trigger-head">
		<h3 class="block-title">데스크탑 트리거 (브릿지)</h3>
		<span class="health" class:ok={triggerHealth === 'ok'} class:down={triggerHealth === 'down'}>
			{triggerHealth === 'ok'
				? '● 연결됨'
				: triggerHealth === 'down'
					? '● 응답 없음'
					: '○ 미확인'}
		</span>
	</div>
	<div class="trigger-grid">
		<label class="field">
			<span class="field-label">URL</span>
			<input
				type="url"
				placeholder="https://my-desktop.example/diary"
				bind:value={triggerUrlInput}
				class="input"
			/>
		</label>
		<label class="field">
			<span class="field-label">Bearer 토큰</span>
			<input
				type="password"
				placeholder="DIARY_TRIGGER_TOKEN"
				bind:value={triggerTokenInput}
				class="input"
				autocomplete="off"
			/>
		</label>
		<div class="trigger-actions">
			<button class="btn-sm" onclick={saveSettings} disabled={savingSettings}>
				{savingSettings ? '저장 중...' : '저장'}
			</button>
			<button
				class="btn-sm subtle"
				onclick={runTriggerNow}
				disabled={triggerActionBusy || !triggerUrl || !triggerToken}
			>
				지금 신호 보내기
			</button>
			<button
				class="btn-sm subtle"
				onclick={refreshTriggerStatus}
				disabled={!triggerUrl || !triggerToken}
			>
				상태 확인
			</button>
		</div>
	</div>
	{#if triggerStatus}
		<div class="trigger-status">
			{#if triggerStatus.running}
				<span class="badge running">실행 중</span>
				{#if triggerStatus.jobId}<span class="muted small">job {triggerStatus.jobId}</span>{/if}
				{#if triggerStatus.startedAt}<span class="muted small"
						>시작 {triggerStatus.startedAt}</span
					>{/if}
			{:else if triggerStatus.exitCode != null}
				<span
					class="badge"
					class:ok={triggerStatus.exitCode === 0}
					class:err={triggerStatus.exitCode !== 0}
				>
					지난 실행 종료 코드 {triggerStatus.exitCode}
				</span>
				{#if triggerStatus.finishedAt}<span class="muted small"
						>종료 {triggerStatus.finishedAt}</span
					>{/if}
			{:else}
				<span class="muted small">트리거 대기 중</span>
			{/if}
		</div>
		{#if triggerStatus.stderrTail && triggerStatus.exitCode !== 0}
			<details class="trigger-tail">
				<summary>stderr (마지막)</summary>
				<pre>{triggerStatus.stderrTail}</pre>
			</details>
		{/if}
	{/if}
</section>

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

	.trigger-panel {
		border: 1px solid var(--color-border, #e5e7eb);
		border-radius: 8px;
		padding: 12px 14px;
		margin-bottom: 20px;
		background: var(--color-bg-secondary, #f9fafb);
	}
	.trigger-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 10px;
	}
	.block-title {
		margin: 0;
		font-size: 0.9rem;
		font-weight: 600;
	}
	.health {
		font-size: 0.78rem;
		color: var(--color-text-secondary, #6b7280);
	}
	.health.ok {
		color: #059669;
	}
	.health.down {
		color: #b91c1c;
	}
	.trigger-grid {
		display: grid;
		grid-template-columns: 2fr 1fr auto;
		gap: 10px;
		align-items: end;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.field-label {
		font-size: 0.72rem;
		color: var(--color-text-secondary, #6b7280);
	}
	.input {
		padding: 6px 8px;
		font-size: 0.85rem;
		border: 1px solid var(--color-border, #d1d5db);
		border-radius: 5px;
		font-family: inherit;
		background: white;
	}
	.trigger-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.trigger-status {
		margin-top: 10px;
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.badge.running {
		background: #dbeafe;
		color: #1d4ed8;
	}
	.badge.ok {
		background: #ecfdf5;
		color: #065f46;
	}
	.badge.err {
		background: #fef2f2;
		color: #b91c1c;
	}
	.muted.small {
		font-size: 0.75rem;
		color: var(--color-text-secondary, #6b7280);
	}
	.trigger-tail {
		margin-top: 8px;
		font-size: 0.78rem;
	}
	.trigger-tail pre {
		background: #1f2937;
		color: #f9fafb;
		padding: 8px;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.72rem;
		max-height: 200px;
		overflow-y: auto;
	}

	@media (max-width: 720px) {
		.trigger-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
