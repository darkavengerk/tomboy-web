<script lang="ts">
	import type { SyncProgress } from '$lib/sync/syncManager.js';

	interface Props {
		progress: SyncProgress;
	}

	let { progress }: Props = $props();

	let doneCount = $derived(progress.items.filter((i) => i.status === 'done').length);
	let errorCount = $derived(progress.items.filter((i) => i.status === 'error').length);
</script>

<div class="progress-view">
	<!-- Completed phases summary -->
	{#each progress.completedPhases as phase}
		<div class="phase-summary" class:has-errors={phase.errors > 0}>
			<span class="phase-icon done">✓</span>
			<span class="phase-text">
				{phase.label} {phase.count}개 완료
				{#if phase.errors > 0}
					<span class="error-count">({phase.errors}개 실패)</span>
				{/if}
			</span>
		</div>
	{/each}

	<!-- Current phase -->
	{#if progress.phase !== 'done' && progress.items.length > 0}
		<div class="phase-current">
			<div class="phase-header">
				<span class="phase-icon active-dot"></span>
				<span class="phase-label">{progress.phaseLabel}</span>
				<span class="phase-count">{doneCount}/{progress.items.length}</span>
				{#if errorCount > 0}
					<span class="error-count">({errorCount}개 실패)</span>
				{/if}
			</div>

			<div class="item-list">
				{#each progress.items as item (item.guid)}
					<div
						class="item-row"
						class:active={item.status === 'active'}
						class:done={item.status === 'done'}
						class:error={item.status === 'error'}
						class:retrying={item.status === 'retrying'}
					>
						<span class="item-icon">
							{#if item.status === 'pending'}
								<span class="icon-pending">·</span>
							{:else if item.status === 'active'}
								<span class="icon-active"></span>
							{:else if item.status === 'done'}
								<span class="icon-done">✓</span>
							{:else if item.status === 'error'}
								<span class="icon-error">✗</span>
							{:else if item.status === 'retrying'}
								<span class="icon-retrying">↻</span>
							{/if}
						</span>
						<span class="item-title">{item.title ?? item.guid.slice(0, 8)}</span>
						{#if item.status === 'retrying' && item.retryWaitSec}
							<span class="retry-badge">{item.retryWaitSec}초 후 재시도</span>
						{/if}
						{#if item.status === 'error' && item.error}
							<span class="error-badge">실패</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{:else if progress.phase === 'done'}
		<div class="phase-summary">
			<span class="phase-icon done">✓</span>
			<span class="phase-text">동기화 완료</span>
		</div>
	{/if}
</div>

<style>
	.progress-view {
		font-size: 0.85rem;
	}

	.phase-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 0;
		color: var(--color-text-secondary, #666);
	}

	.phase-summary.has-errors {
		color: var(--color-danger, #c62828);
	}

	.phase-icon {
		width: 18px;
		text-align: center;
		flex-shrink: 0;
		font-size: 0.8rem;
	}

	.phase-icon.done {
		color: #2ecc71;
	}

	.phase-icon.active-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-primary, #d05b10);
		animation: pulse 1s infinite;
		margin: 0 5px;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	.phase-text {
		flex: 1;
	}

	.phase-current {
		padding: 8px 0;
	}

	.phase-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--color-border, #eee);
		margin-bottom: 4px;
	}

	.phase-label {
		font-weight: 600;
		color: var(--color-text);
	}

	.phase-count {
		color: var(--color-text-secondary, #888);
		font-size: 0.8rem;
	}

	.error-count {
		color: var(--color-danger, #c62828);
		font-size: 0.8rem;
	}

	.item-list {
		max-height: 240px;
		overflow-y: auto;
	}

	.item-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
		color: var(--color-text-secondary, #999);
		transition: color 0.15s;
	}

	.item-row.active {
		color: var(--color-text);
		font-weight: 500;
	}

	.item-row.done {
		color: var(--color-text-secondary, #999);
	}

	.item-row.error {
		color: var(--color-danger, #c62828);
	}

	.item-row.retrying {
		color: #e67e22;
	}

	.item-icon {
		width: 18px;
		text-align: center;
		flex-shrink: 0;
		font-size: 0.8rem;
	}

	.icon-pending {
		color: #ccc;
		font-size: 1.2rem;
		line-height: 1;
	}

	.icon-active {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-primary, #d05b10);
		animation: pulse 1s infinite;
	}

	.icon-done {
		color: #2ecc71;
	}

	.icon-error {
		color: var(--color-danger, #c62828);
	}

	.icon-retrying {
		color: #e67e22;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	.item-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.retry-badge {
		font-size: 0.72rem;
		color: #e67e22;
		background: #fff8e1;
		padding: 1px 6px;
		border-radius: 4px;
		flex-shrink: 0;
	}

	.error-badge {
		font-size: 0.72rem;
		color: var(--color-danger, #c62828);
		background: #ffeef0;
		padding: 1px 6px;
		border-radius: 4px;
		flex-shrink: 0;
	}
</style>
