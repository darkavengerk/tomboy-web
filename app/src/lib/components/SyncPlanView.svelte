<script lang="ts">
	import type {
		SyncPlan,
		PlanSelection,
		SyncProgress,
		SyncProgressItem
	} from '$lib/sync/syncManager.js';
	import { revertNoteToServer } from '$lib/sync/syncManager.js';
	import { pushToast } from '$lib/stores/toast.js';
	import { goto } from '$app/navigation';

	interface Props {
		plan: SyncPlan;
		selection: PlanSelection;
		/**
		 * Live sync progress. When set, per-row status indicators are shown and
		 * interactive controls (checkboxes, revert, conflict radios) are disabled.
		 * `null`/undefined puts the view in normal preview mode.
		 */
		progress?: SyncProgress | null;
	}

	let { plan, selection, progress = null }: Props = $props();

	// Build a guid → SyncProgressItem map spanning both completed and current
	// phases. Later phases overwrite earlier ones — so a note that appeared in
	// 충돌 해결 then 업로드 shows its upload status.
	let statusByGuid = $derived.by(() => {
		const m = new Map<string, SyncProgressItem>();
		if (!progress) return m;
		for (const phase of progress.completedPhases) {
			for (const item of phase.items) m.set(item.guid, item);
		}
		for (const item of progress.items) m.set(item.guid, item);
		return m;
	});

	let isSyncing = $derived(progress !== null);

	// Local checkbox state, initialized from plan (all selected by default)
	let downloadSel = $state<Record<string, boolean>>({});
	let uploadSel = $state<Record<string, boolean>>({});
	let deleteRemoteSel = $state<Record<string, boolean>>({});
	let deleteLocalSel = $state<Record<string, boolean>>({});
	let conflictChoice = $state<Record<string, 'local' | 'remote' | 'merge'>>({});

	// GUIDs that were reverted (server version pulled down) — hidden from the
	// upload list without mutating the plan prop. Also cleared from uploadSel.
	let reverted = $state<Record<string, boolean>>({});
	let reverting = $state<Record<string, boolean>>({});
	let bulkReverting = $state(false);

	// Initialize once from plan
	$effect(() => {
		downloadSel = Object.fromEntries(plan.toDownload.map((x) => [x.guid, true]));
		uploadSel = Object.fromEntries(plan.toUpload.map((x) => [x.guid, true]));
		deleteRemoteSel = Object.fromEntries(plan.toDeleteRemote.map((x) => [x.guid, true]));
		deleteLocalSel = Object.fromEntries(plan.toDeleteLocal.map((x) => [x.guid, true]));
		conflictChoice = Object.fromEntries(plan.conflicts.map((c) => [c.guid, c.suggested]));
	});

	// Sync reactive objects back to the selection prop
	$effect(() => {
		selection.download = new Set(
			Object.entries(downloadSel)
				.filter(([, v]) => v)
				.map(([k]) => k)
		);
	});
	$effect(() => {
		selection.upload = new Set(
			Object.entries(uploadSel)
				.filter(([k, v]) => v && !reverted[k])
				.map(([k]) => k)
		);
	});
	$effect(() => {
		selection.deleteRemote = new Set(
			Object.entries(deleteRemoteSel)
				.filter(([, v]) => v)
				.map(([k]) => k)
		);
	});
	$effect(() => {
		selection.deleteLocal = new Set(
			Object.entries(deleteLocalSel)
				.filter(([, v]) => v)
				.map(([k]) => k)
		);
	});
	$effect(() => {
		selection.conflictChoice = new Map(
			Object.entries(conflictChoice)
		) as Map<string, 'local' | 'remote' | 'merge'>;
	});

	// ── Revert handlers ──────────────────────────────────────────────────────
	async function revertOne(guid: string) {
		if (reverting[guid]) return;
		reverting[guid] = true;
		try {
			const res = await revertNoteToServer(guid);
			if (res.status === 'success') {
				reverted[guid] = true;
				uploadSel[guid] = false;
				pushToast('변경 취소 완료');
			} else {
				pushToast(res.message ?? '변경 취소 실패', { kind: 'error' });
			}
		} catch (e) {
			pushToast('변경 취소 실패: ' + String(e), { kind: 'error' });
		} finally {
			reverting[guid] = false;
		}
	}

	async function revertAllUploads() {
		if (bulkReverting) return;
		const targets = plan.toUpload.filter((u) => !reverted[u.guid]);
		if (targets.length === 0) return;
		const ok = confirm(
			`업로드 예정인 ${targets.length}개 노트를 모두 서버 버전으로 되돌립니다.\n로컬 변경사항은 사라집니다. 계속할까요?`
		);
		if (!ok) return;
		bulkReverting = true;
		let success = 0;
		let fail = 0;
		try {
			for (const item of targets) {
				reverting[item.guid] = true;
				try {
					const res = await revertNoteToServer(item.guid);
					if (res.status === 'success') {
						reverted[item.guid] = true;
						uploadSel[item.guid] = false;
						success++;
					} else {
						fail++;
					}
				} catch {
					fail++;
				} finally {
					reverting[item.guid] = false;
				}
			}
			if (fail === 0) {
				pushToast(`${success}개 노트 변경 취소 완료`);
			} else {
				pushToast(`${success}개 성공, ${fail}개 실패`, { kind: 'error' });
			}
		} finally {
			bulkReverting = false;
		}
	}

	let uploadRemaining = $derived(plan.toUpload.filter((u) => !reverted[u.guid]).length);

	function openNote(guid: string) {
		goto(`/note/${guid}`);
	}
</script>

<div class="plan-view">
	{#if plan.serverWasWiped}
		<div class="warn-banner">
			⚠️ 서버가 재설정되었습니다. 동기화 시 로컬 매니페스트가 재생성됩니다.
		</div>
	{/if}

	<!-- Downloads -->
	{#if plan.toDownload.length > 0}
	<section>
		<h3 class="section-title">⬇ 다운로드 ({plan.toDownload.length})</h3>
		{#each plan.toDownload as item (item.guid)}
			{@const status = statusByGuid.get(item.guid)}
			<div class="plan-item" class:row-done={status?.status === 'done'} class:row-error={status?.status === 'error'} class:row-active={status?.status === 'active'}>
				<input
					type="checkbox"
					class="row-check"
					bind:checked={downloadSel[item.guid]}
					onclick={(e) => e.stopPropagation()}
					disabled={isSyncing}
					aria-label="선택"
				/>
				<button type="button" class="row-link" onclick={() => openNote(item.guid)}>
					<span class="item-title">{item.title ?? item.guid}</span>
					<span class="item-reason">{item.reason}</span>
				</button>
				{@render statusBadge(status)}
			</div>
		{/each}
	</section>
	{/if}

	<!-- Uploads -->
	{#if uploadRemaining > 0}
	<section>
		<div class="section-head">
			<h3 class="section-title">⬆ 업로드 ({uploadRemaining})</h3>
			{#if !isSyncing}
				<button
					class="revert-bulk-btn"
					type="button"
					disabled={bulkReverting || uploadRemaining === 0}
					onclick={revertAllUploads}
				>
					{bulkReverting ? '되돌리는 중...' : '모두 변경 취소'}
				</button>
			{/if}
		</div>
		{#each plan.toUpload as item (item.guid)}
			{#if !reverted[item.guid]}
				{@const status = statusByGuid.get(item.guid)}
				<div class="plan-item-row">
					<div class="plan-item" class:row-done={status?.status === 'done'} class:row-error={status?.status === 'error'} class:row-active={status?.status === 'active'}>
						<input
							type="checkbox"
							class="row-check"
							bind:checked={uploadSel[item.guid]}
							onclick={(e) => e.stopPropagation()}
							disabled={isSyncing}
							aria-label="선택"
						/>
						<button type="button" class="row-link" onclick={() => openNote(item.guid)}>
							<span class="item-title">{item.title ?? item.guid}</span>
							<span class="item-reason">{item.reason}</span>
						</button>
						{@render statusBadge(status)}
					</div>
					{#if !isSyncing}
						<button
							class="revert-btn"
							type="button"
							disabled={reverting[item.guid] || bulkReverting || item.reason === 'new'}
							title={item.reason === 'new'
								? '새 노트는 서버에 없어 되돌릴 수 없습니다'
								: '서버 버전으로 되돌리고 업로드 대상에서 제외합니다'}
							onclick={() => revertOne(item.guid)}
						>
							{reverting[item.guid] ? '...' : '변경 취소'}
						</button>
					{/if}
				</div>
			{/if}
		{/each}
	</section>
	{/if}

	<!-- Delete remote -->
	{#if plan.toDeleteRemote.length > 0}
	<section>
		<h3 class="section-title">🗑 서버에서 삭제 ({plan.toDeleteRemote.length})</h3>
		{#each plan.toDeleteRemote as item (item.guid)}
			{@const status = statusByGuid.get(item.guid)}
			<div class="plan-item" class:row-done={status?.status === 'done'} class:row-error={status?.status === 'error'} class:row-active={status?.status === 'active'}>
				<input
					type="checkbox"
					class="row-check"
					bind:checked={deleteRemoteSel[item.guid]}
					onclick={(e) => e.stopPropagation()}
					disabled={isSyncing}
					aria-label="선택"
				/>
				<button type="button" class="row-link" onclick={() => openNote(item.guid)}>
					<span class="item-title">{item.title ?? item.guid}</span>
				</button>
				{@render statusBadge(status)}
			</div>
		{/each}
	</section>
	{/if}

	<!-- Delete local -->
	{#if plan.toDeleteLocal.length > 0}
	<section>
		<h3 class="section-title">🗑 로컬에서 삭제 ({plan.toDeleteLocal.length})</h3>
		{#each plan.toDeleteLocal as item (item.guid)}
			{@const status = statusByGuid.get(item.guid)}
			<div class="plan-item" class:row-done={status?.status === 'done'} class:row-error={status?.status === 'error'} class:row-active={status?.status === 'active'}>
				<input
					type="checkbox"
					class="row-check"
					bind:checked={deleteLocalSel[item.guid]}
					onclick={(e) => e.stopPropagation()}
					disabled={isSyncing}
					aria-label="선택"
				/>
				<span class="row-link row-link-disabled">
					<span class="item-title">{item.title ?? item.guid}</span>
				</span>
				{@render statusBadge(status)}
			</div>
		{/each}
	</section>
	{/if}

	<!-- Conflicts -->
	{#if plan.conflicts.length > 0}
	<section>
		<h3 class="section-title">⚠️ 충돌 ({plan.conflicts.length})</h3>
		<p class="conflict-help">자동 머지는 양쪽이 다른 부분을 편집한 경우에만 성공합니다. 같은 부분이 겹치면 실패로 보고되고, 해당 노트는 건드리지 않은 채 남습니다 — '내 버전 유지' 또는 '서버 버전으로 교체'를 선택해서 다시 시도하세요.</p>
			{#if !isSyncing}
				<div class="bulk-btns">
					<button class="bulk-btn" onclick={() => {
						for (const c of plan.conflicts) conflictChoice[c.guid] = c.canMerge ? 'merge' : c.suggested;
					}}>
						모두 자동 머지
					</button>
					<button class="bulk-btn" onclick={() => {
						for (const c of plan.conflicts) conflictChoice[c.guid] = 'local';
					}}>
						모두 로컬로 유지
					</button>
					<button class="bulk-btn" onclick={() => {
						for (const c of plan.conflicts) conflictChoice[c.guid] = 'remote';
					}}>
						모두 서버로 덮어쓰기
					</button>
				</div>
			{/if}
			{#each plan.conflicts as conflict (conflict.guid)}
				{@const status = statusByGuid.get(conflict.guid)}
				<fieldset class="conflict-item" class:row-done={status?.status === 'done'} class:row-error={status?.status === 'error'} class:row-active={status?.status === 'active'}>
					<legend class="conflict-title">
						<span class="conflict-legend-text">{conflict.title ?? conflict.guid}</span>
						{@render statusBadge(status)}
					</legend>
					{#if conflict.canMerge}
						<label class="radio-label">
							<input type="radio" bind:group={conflictChoice[conflict.guid]} value="merge" disabled={isSyncing} />
							<span>자동 머지 (겹치지 않는 변경을 합침)</span>
						</label>
					{/if}
					<label class="radio-label">
						<input type="radio" bind:group={conflictChoice[conflict.guid]} value="local" disabled={isSyncing} />
						<span>
							내 버전 유지 (서버 덮어씀)
							{#if conflict.localDate}<span class="date-badge">{conflict.localDate.slice(0, 10)}</span>{/if}
						</span>
					</label>
					<label class="radio-label">
						<input type="radio" bind:group={conflictChoice[conflict.guid]} value="remote" disabled={isSyncing} />
						<span>
							서버 버전으로 교체 (로컬 덮어씀)
							{#if conflict.remoteDate}<span class="date-badge">{conflict.remoteDate.slice(0, 10)}</span>{/if}
						</span>
					</label>
				</fieldset>
		{/each}
	</section>
	{/if}
</div>

{#snippet statusBadge(status: SyncProgressItem | undefined)}
	{#if status}
		<span class="status-cell" aria-label={status.status}>
			{#if status.status === 'pending'}
				<span class="status-icon icon-pending" title="대기 중">·</span>
			{:else if status.status === 'active'}
				<span class="status-icon icon-active" title="진행 중"></span>
			{:else if status.status === 'done'}
				<span class="status-icon icon-done" title="완료">✓</span>
			{:else if status.status === 'error'}
				<span class="status-icon icon-error" title={status.error ?? '실패'}>✗</span>
			{:else if status.status === 'retrying'}
				<span class="status-icon icon-retrying" title="재시도 중">↻</span>
			{/if}
			{#if status.status === 'retrying' && status.retryWaitSec}
				<span class="retry-badge">{status.retryWaitSec}초 후 재시도</span>
			{/if}
			{#if status.status === 'error' && status.error}
				<span class="error-badge" title={status.error}>실패</span>
			{/if}
		</span>
	{/if}
{/snippet}

<style>
	.plan-view {
		font-size: 0.9rem;
	}

	.warn-banner {
		background: #fff3cd;
		color: #856404;
		padding: 10px 14px;
		border-radius: 8px;
		margin-bottom: 12px;
		font-size: 0.85rem;
	}

	section {
		margin-bottom: 16px;
	}

	.section-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--color-text-secondary, #666);
		margin-bottom: 6px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--color-border, #eee);
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 6px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--color-border, #eee);
	}

	.section-head .section-title {
		margin: 0;
		padding: 0;
		border: none;
		flex: 1;
		min-width: 0;
	}

	.plan-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 0;
		flex: 1;
		min-width: 0;
	}

	.plan-item-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}

	.row-check {
		flex-shrink: 0;
		margin-top: 3px;
		cursor: pointer;
	}

	.row-link {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		align-items: flex-start;
		gap: 8px;
		flex-wrap: wrap;
		background: none;
		border: none;
		padding: 0;
		text-align: left;
		color: inherit;
		cursor: pointer;
		font: inherit;
	}

	.row-link:hover:not(.row-link-disabled) .item-title {
		text-decoration: underline;
		color: var(--color-primary, #d05b10);
	}

	.row-link-disabled {
		cursor: default;
	}

	.item-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
		word-break: break-word;
		white-space: normal;
	}

	.item-reason {
		font-size: 0.75rem;
		color: var(--color-text-secondary, #888);
		background: var(--color-bg-secondary, #f5f5f5);
		padding: 1px 6px;
		border-radius: 4px;
		flex-shrink: 0;
		align-self: flex-start;
	}

	.revert-btn {
		font-size: 0.75rem;
		padding: 2px 8px;
		border: 1px solid #e57373;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
		color: #c62828;
		flex-shrink: 0;
		white-space: nowrap;
		align-self: flex-start;
	}

	.revert-btn:hover:not(:disabled) {
		background: #ffebee;
	}

	.revert-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.revert-bulk-btn {
		font-size: 0.75rem;
		padding: 4px 10px;
		border: 1px solid #e57373;
		border-radius: 6px;
		background: #fff;
		cursor: pointer;
		color: #c62828;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.revert-bulk-btn:hover:not(:disabled) {
		background: #ffebee;
	}

	.revert-bulk-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.conflict-help {
		font-size: 0.78rem;
		color: var(--color-text-secondary, #888);
		margin-bottom: 8px;
	}

	.bulk-btns {
		display: flex;
		gap: 6px;
		margin-bottom: 10px;
	}

	.bulk-btn {
		flex: 1;
		font-size: 0.75rem;
		padding: 5px 8px;
		border: 1px solid #ffc107;
		border-radius: 6px;
		background: #fff8e1;
		color: #6d4c00;
		cursor: pointer;
	}

	.bulk-btn:active {
		background: #ffe082;
	}

	.conflict-item {
		border: 1px solid #ffc107;
		border-radius: 8px;
		padding: 10px 14px;
		margin-bottom: 8px;
	}

	.conflict-title {
		font-weight: 600;
		font-size: 0.85rem;
	}

	.radio-label {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		cursor: pointer;
	}

	.date-badge {
		font-size: 0.72rem;
		color: var(--color-text-secondary, #888);
		background: var(--color-bg-secondary, #f5f5f5);
		padding: 1px 5px;
		border-radius: 4px;
		margin-left: 4px;
	}

	/* ── Per-row sync status ───────────────────────────────────────────── */

	.status-cell {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		align-self: flex-start;
		margin-top: 3px;
	}

	.status-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		font-size: 0.85rem;
		line-height: 1;
	}

	.icon-pending {
		color: #ccc;
		font-size: 1.2rem;
		line-height: 1;
	}

	.icon-active {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-primary, #d05b10);
		animation: sp-pulse 1s infinite;
	}

	.icon-done {
		color: #2ecc71;
	}

	.icon-error {
		color: var(--color-danger, #c62828);
	}

	.icon-retrying {
		color: #e67e22;
		animation: sp-spin 1s linear infinite;
	}

	@keyframes sp-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	@keyframes sp-spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	.retry-badge {
		font-size: 0.72rem;
		color: #e67e22;
		background: #fff8e1;
		padding: 1px 6px;
		border-radius: 4px;
	}

	.error-badge {
		font-size: 0.72rem;
		color: var(--color-danger, #c62828);
		background: #ffeef0;
		padding: 1px 6px;
		border-radius: 4px;
	}

	.row-done :global(.item-title) {
		color: var(--color-text-secondary, #999);
	}

	.row-error :global(.item-title) {
		color: var(--color-danger, #c62828);
	}

	.row-active :global(.item-title) {
		font-weight: 500;
	}

	.conflict-legend-text {
		display: inline-block;
		margin-right: 6px;
	}
</style>
