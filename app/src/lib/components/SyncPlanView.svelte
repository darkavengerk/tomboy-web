<script lang="ts">
	import type { SyncPlan, PlanSelection } from '$lib/sync/syncManager.js';

	interface Props {
		plan: SyncPlan;
		selection: PlanSelection;
	}

	let { plan, selection }: Props = $props();

	// Local checkbox state, initialized from plan (all selected by default)
	let downloadSel = $state<Record<string, boolean>>({});
	let uploadSel = $state<Record<string, boolean>>({});
	let deleteRemoteSel = $state<Record<string, boolean>>({});
	let deleteLocalSel = $state<Record<string, boolean>>({});
	let conflictChoice = $state<Record<string, 'local' | 'remote'>>({});
	let openPreview = $state<string | null>(null);

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
				.filter(([, v]) => v)
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
		) as Map<string, 'local' | 'remote'>;
	});

	function previewText(guid: string): string {
		const item = plan.toUpload.find((x) => x.guid === guid);
		return item ? `제목: ${item.title ?? guid}` : '';
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
			<label class="plan-item">
				<input type="checkbox" bind:checked={downloadSel[item.guid]} />
				<span class="item-title">{item.title ?? item.guid}</span>
				<span class="item-reason">{item.reason}</span>
			</label>
		{/each}
	</section>
	{/if}

	<!-- Uploads -->
	{#if plan.toUpload.length > 0}
	<section>
		<h3 class="section-title">⬆ 업로드 ({plan.toUpload.length})</h3>
		{#each plan.toUpload as item (item.guid)}
			<div class="plan-item-row">
				<label class="plan-item">
					<input type="checkbox" bind:checked={uploadSel[item.guid]} />
					<span class="item-title">{item.title ?? item.guid}</span>
					<span class="item-reason">{item.reason}</span>
				</label>
				<button
					class="preview-btn"
					onclick={() => (openPreview = openPreview === item.guid ? null : item.guid)}
				>
					미리보기
				</button>
			</div>
			{#if openPreview === item.guid}
				<pre class="preview-text">{previewText(item.guid)}</pre>
			{/if}
		{/each}
	</section>
	{/if}

	<!-- Delete remote -->
	{#if plan.toDeleteRemote.length > 0}
	<section>
		<h3 class="section-title">🗑 서버에서 삭제 ({plan.toDeleteRemote.length})</h3>
		{#each plan.toDeleteRemote as item (item.guid)}
			<label class="plan-item">
				<input type="checkbox" bind:checked={deleteRemoteSel[item.guid]} />
				<span class="item-title">{item.title ?? item.guid}</span>
			</label>
		{/each}
	</section>
	{/if}

	<!-- Delete local -->
	{#if plan.toDeleteLocal.length > 0}
	<section>
		<h3 class="section-title">🗑 로컬에서 삭제 ({plan.toDeleteLocal.length})</h3>
		{#each plan.toDeleteLocal as item (item.guid)}
			<label class="plan-item">
				<input type="checkbox" bind:checked={deleteLocalSel[item.guid]} />
				<span class="item-title">{item.title ?? item.guid}</span>
			</label>
		{/each}
	</section>
	{/if}

	<!-- Conflicts -->
	{#if plan.conflicts.length > 0}
	<section>
		<h3 class="section-title">⚠️ 충돌 ({plan.conflicts.length})</h3>
		<p class="conflict-help">선택한 버전이 최종적으로 남고, 반대쪽을 덮어씁니다.</p>
			<div class="bulk-btns">
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
			{#each plan.conflicts as conflict (conflict.guid)}
				<fieldset class="conflict-item">
					<legend class="conflict-title">{conflict.title ?? conflict.guid}</legend>
					<label class="radio-label">
						<input type="radio" bind:group={conflictChoice[conflict.guid]} value="local" />
						<span>
							내 버전 유지 (서버 덮어씀)
							{#if conflict.localDate}<span class="date-badge">{conflict.localDate.slice(0, 10)}</span>{/if}
						</span>
					</label>
					<label class="radio-label">
						<input type="radio" bind:group={conflictChoice[conflict.guid]} value="remote" />
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

	.plan-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 0;
		cursor: pointer;
		flex: 1;
	}

	.plan-item-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.item-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item-reason {
		font-size: 0.75rem;
		color: var(--color-text-secondary, #888);
		background: var(--color-bg-secondary, #f5f5f5);
		padding: 1px 6px;
		border-radius: 4px;
		flex-shrink: 0;
	}

	.preview-btn {
		font-size: 0.75rem;
		padding: 2px 8px;
		border: 1px solid var(--color-border, #ddd);
		border-radius: 4px;
		background: none;
		cursor: pointer;
		color: var(--color-primary, #1a73e8);
		flex-shrink: 0;
	}

	.preview-text {
		background: var(--color-bg-secondary, #f5f5f5);
		padding: 8px 12px;
		border-radius: 6px;
		font-size: 0.8rem;
		white-space: pre-wrap;
		word-break: break-all;
		margin: 4px 0 8px;
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
</style>
