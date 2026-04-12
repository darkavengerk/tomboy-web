<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { compareWithServer, type CompareResult } from '$lib/sync/diffNote.js';

	let guid = $derived(page.params.id ?? '');

	let loading = $state(true);
	let result = $state<CompareResult | null>(null);
	let viewMode = $state<'diff' | 'local' | 'server'>('diff');

	onMount(async () => {
		await runCompare();
	});

	async function runCompare() {
		if (!guid) {
			result = { status: 'error', message: '노트 ID 를 찾을 수 없습니다' };
			loading = false;
			return;
		}
		loading = true;
		try {
			result = await compareWithServer(guid);
		} catch (e) {
			result = { status: 'error', message: String(e) };
		} finally {
			loading = false;
		}
	}

	function goBack() {
		if (history.length > 1) history.back();
		else goto(`/note/${guid}`);
	}

	let addedCount = $derived(result?.diff?.filter((d) => d.type === 'added').length ?? 0);
	let removedCount = $derived(result?.diff?.filter((d) => d.type === 'removed').length ?? 0);
</script>

<svelte:head><title>원본과 비교하기</title></svelte:head>

<div class="page">
	<header class="top-bar">
		<button class="back-btn" onclick={goBack} aria-label="뒤로">
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
				<polyline points="15 18 9 12 15 6" />
			</svg>
		</button>
		<h1 class="title">원본과 비교하기</h1>
		<button class="refresh-btn" onclick={runCompare} disabled={loading}>
			{loading ? '불러오는 중...' : '새로고침'}
		</button>
	</header>

	<div class="body">
		{#if loading}
			<p class="status-text">서버에서 원본을 불러오는 중...</p>
		{:else if !result}
			<p class="status-text">결과가 없습니다.</p>
		{:else if result.status === 'error'}
			<div class="error-banner">⚠️ {result.message}</div>
			{#if result.localXml}
				<h3 class="section-title">로컬 XML</h3>
				<pre class="xml">{result.localXml}</pre>
			{/if}
		{:else if result.status === 'local-only'}
			<div class="info-banner">ℹ️ {result.message}</div>
			<h3 class="section-title">로컬 XML</h3>
			<pre class="xml">{result.localXml}</pre>
		{:else if result.status === 'ok'}
			<div class="summary">
				<span class="rev-badge">서버 rev {result.serverRev}</span>
				{#if addedCount === 0 && removedCount === 0}
					<span class="eq-badge">동일함 ✓</span>
				{:else}
					<span class="added-badge">+{addedCount}</span>
					<span class="removed-badge">−{removedCount}</span>
				{/if}
			</div>

			<div class="view-toggle">
				<button
					class="toggle-btn"
					class:active={viewMode === 'diff'}
					onclick={() => (viewMode = 'diff')}
				>
					차이점
				</button>
				<button
					class="toggle-btn"
					class:active={viewMode === 'local'}
					onclick={() => (viewMode = 'local')}
				>
					로컬
				</button>
				<button
					class="toggle-btn"
					class:active={viewMode === 'server'}
					onclick={() => (viewMode = 'server')}
				>
					서버
				</button>
			</div>

			{#if viewMode === 'diff'}
				<pre class="xml diff">{#each result.diff ?? [] as op, i (i)}<span
							class="line line-{op.type}"
						>{op.type === 'added' ? '+ ' : op.type === 'removed' ? '- ' : '  '}{op.text}
</span>{/each}</pre>
			{:else if viewMode === 'local'}
				<pre class="xml">{result.localXml}</pre>
			{:else}
				<pre class="xml">{result.serverXml}</pre>
			{/if}
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	.top-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--color-border, #eee);
		flex-shrink: 0;
	}

	.back-btn,
	.refresh-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: 1px solid var(--color-border, #ddd);
		border-radius: 6px;
		padding: 6px 10px;
		cursor: pointer;
		color: var(--color-text, #111);
		font-size: 0.85rem;
	}

	.back-btn {
		padding: 6px 8px;
	}

	.refresh-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		flex: 1;
	}

	.body {
		overflow-y: auto;
		padding: 12px;
		flex: 1;
	}

	.status-text,
	.error-banner,
	.info-banner {
		padding: 12px 14px;
		border-radius: 8px;
		font-size: 0.9rem;
	}

	.error-banner {
		background: #fdecea;
		color: #b71c1c;
		margin-bottom: 12px;
	}

	.info-banner {
		background: #e3f2fd;
		color: #1565c0;
		margin-bottom: 12px;
	}

	.summary {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
		flex-wrap: wrap;
	}

	.summary span {
		font-size: 0.78rem;
		padding: 2px 8px;
		border-radius: 4px;
	}

	.rev-badge {
		background: var(--color-bg-secondary, #f5f5f5);
		color: var(--color-text-secondary, #666);
	}

	.eq-badge {
		background: #e8f5e9;
		color: #2e7d32;
	}

	.added-badge {
		background: #e8f5e9;
		color: #2e7d32;
	}

	.removed-badge {
		background: #fdecea;
		color: #b71c1c;
	}

	.view-toggle {
		display: flex;
		gap: 4px;
		margin-bottom: 8px;
	}

	.toggle-btn {
		flex: 1;
		padding: 6px 8px;
		font-size: 0.8rem;
		background: var(--color-bg-secondary, #f5f5f5);
		border: 1px solid var(--color-border, #ddd);
		border-radius: 6px;
		cursor: pointer;
		color: var(--color-text-secondary, #666);
	}

	.toggle-btn.active {
		background: var(--color-primary, #d05b10);
		color: #fff;
		border-color: var(--color-primary, #d05b10);
	}

	.section-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--color-text-secondary, #666);
		margin: 12px 0 6px;
	}

	.xml {
		background: var(--color-bg-secondary, #f5f5f5);
		padding: 10px 12px;
		border-radius: 6px;
		font-family: monospace;
		font-size: 0.78rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-all;
		margin: 0;
		overflow-x: auto;
	}

	.xml.diff {
		padding: 0;
		background: none;
	}

	.line {
		display: block;
		padding: 1px 10px;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.line-equal {
		color: var(--color-text, #333);
	}

	.line-added {
		background: #e8f5e9;
		color: #1b5e20;
	}

	.line-removed {
		background: #fdecea;
		color: #b71c1c;
	}
</style>
