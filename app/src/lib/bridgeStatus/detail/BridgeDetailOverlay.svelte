<script lang="ts">
	import { fetchBridgeDetail, BridgeStatusError, type StatusErrorKind } from '$lib/bridgeStatus/statusClient.js';
	import { DETAIL_REGISTRY } from './registry.js';

	let { serviceKey, onclose }: { serviceKey: string; onclose: () => void } = $props();

	const KIND_MESSAGES: Record<StatusErrorKind, string> = {
		not_configured: '브릿지 설정이 필요합니다',
		network: '브릿지에 연결할 수 없습니다',
		service_unavailable: '브릿지에 연결할 수 없습니다',
		unauthorized: '브릿지 인증이 필요합니다',
		bad_request: '잘못된 요청',
		upstream_error: '브릿지 상태 응답 오류'
	};

	const entry = $derived(DETAIL_REGISTRY[serviceKey]);

	let loading = $state(true);
	let errorMsg = $state<string | null>(null);
	let detail = $state<unknown>(null);

	$effect(() => {
		let alive = true;
		loading = true;
		errorMsg = null;
		fetchBridgeDetail(serviceKey as 'diary')
			.then((d) => {
				if (alive) detail = d;
			})
			.catch((err) => {
				if (!alive) return;
				const kind: StatusErrorKind = err instanceof BridgeStatusError ? err.kind : (err?.kind ?? 'network');
				errorMsg = KIND_MESSAGES[kind] ?? '브릿지 상세 조회 실패';
			})
			.finally(() => {
				if (alive) loading = false;
			});
		return () => {
			alive = false;
		};
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div
	class="bridge-detail-backdrop"
	role="button"
	tabindex="-1"
	onclick={onclose}
	onkeydown={(e) => { if (e.key === 'Enter') onclose(); }}
>
	<div class="bridge-detail-panel" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
		<header>
			<strong>{entry?.title ?? serviceKey}</strong>
			<button type="button" class="close" onclick={onclose} aria-label="닫기">✕</button>
		</header>
		<div class="body">
			{#if loading}
				<p class="muted">불러오는 중…</p>
			{:else if errorMsg}
				<p class="err">{errorMsg}</p>
			{:else if entry && detail}
				{@const Comp = entry.component}
				<Comp {detail} />
			{:else}
				<p class="muted">알 수 없는 서비스</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.bridge-detail-backdrop {
		position: fixed;
		inset: 0;
		background: #0007;
		z-index: var(--z-modal);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}
	.bridge-detail-panel {
		background: var(--surface, #fff);
		color: inherit;
		border-radius: 0.8rem;
		max-width: 32rem;
		width: 100%;
		max-height: 85vh;
		overflow: auto;
		box-shadow: 0 10px 40px #0006;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.8rem 1rem;
		border-bottom: 1px solid #8883;
		position: sticky;
		top: 0;
		background: inherit;
	}
	.close { border: none; background: none; font-size: 1rem; cursor: pointer; color: inherit; }
	.body { padding: 1rem; }
	.muted { color: #888; }
	.err { color: #b3261e; }
</style>
