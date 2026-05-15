<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fetchGpuStatus, unloadModel, GpuMonitorError } from '$lib/gpuMonitor/client.js';
	import type { GpuStatusResponse, GpuStatusModel } from '$lib/gpuMonitor/types.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken
	} from '$lib/editor/terminal/bridgeSettings.js';
	import { pushToast } from '$lib/stores/toast.js';

	let status: GpuStatusResponse | null = $state(null);
	let error: string | null = $state(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	const POLL_MS = 5000;

	async function readBridgeCreds(): Promise<{ url: string; token: string } | null> {
		const url = await getDefaultTerminalBridge();
		const token = await getTerminalBridgeToken();
		if (!url || !token) return null;
		return { url, token };
	}

	async function refresh(): Promise<void> {
		const creds = await readBridgeCreds();
		if (!creds) {
			error = '터미널 브릿지 설정이 필요합니다. 설정 → 터미널 브릿지에서 로그인하세요.';
			status = null;
			return;
		}
		try {
			status = await fetchGpuStatus(creds.url, creds.token);
			error = null;
		} catch (err) {
			if (err instanceof GpuMonitorError) {
				error = `브릿지 응답 ${err.status}`;
			} else {
				error = '브릿지 연결 실패';
			}
		}
	}

	function startPolling(): void {
		stopPolling();
		void refresh();
		pollTimer = setInterval(() => void refresh(), POLL_MS);
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	function onVisibilityChange(): void {
		if (document.visibilityState === 'visible') startPolling();
		else stopPolling();
	}

	onMount(() => {
		startPolling();
		document.addEventListener('visibilitychange', onVisibilityChange);
	});

	onDestroy(() => {
		stopPolling();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
	});

	async function handleUnload(m: GpuStatusModel): Promise<void> {
		const creds = await readBridgeCreds();
		if (!creds) return;
		const r = await unloadModel(creds.url, creds.token, {
			backend: m.backend,
			name: m.backend === 'ollama' ? m.name : undefined
		});
		if (r.ok) {
			pushToast(`${m.name} 언로드됨`);
			void refresh();
		} else if (r.status === 423) {
			pushToast('사용 중 — 잠시 후 다시 시도', { kind: 'error' });
		} else {
			pushToast(`언로드 실패: ${r.message ?? r.status}`, { kind: 'error' });
		}
	}

	function formatIdle(s: number | null): string {
		if (s === null) return '—';
		if (s < 60) return `${Math.round(s)}초 전 사용`;
		const m = Math.floor(s / 60);
		const rem = Math.round(s % 60);
		return `${m}분 ${rem}초 전 사용`;
	}
</script>

<div class="page">
	<h1>GPU</h1>

	{#if error}
		<div class="error-banner">{error}</div>
	{/if}

	{#if status?.vram}
		<section class="vram">
			<div class="bar">
				<div
					class="fill"
					style="width: {(status.vram.used_mb / status.vram.total_mb) * 100}%"
				></div>
			</div>
			<div class="vram-label">
				{status.vram.used_mb} / {status.vram.total_mb} MB
				({Math.round((status.vram.used_mb / status.vram.total_mb) * 100)}%)
			</div>
		</section>
	{:else if status && !status.gpu_available}
		<p class="empty">GPU 정보를 가져올 수 없습니다 (nvidia-smi 응답 없음).</p>
	{/if}

	{#if status}
		<section class="models">
			<h2>로드된 모델</h2>
			{#if status.models.length === 0}
				<p class="empty">로드된 모델 없음.</p>
			{:else}
				<ul>
					{#each status.models as m (m.backend + ':' + m.name)}
						<li>
							<div class="row">
								<div class="meta">
									<span class="name">{m.name}</span>
									<span class="badge">{m.backend}</span>
									<span class="size">{m.size_mb} MB</span>
								</div>
								<div class="idle">{formatIdle(m.idle_for_s)}</div>
								<button
									type="button"
									disabled={!m.unloadable}
									onclick={() => handleUnload(m)}
								>
									언로드
								</button>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if status.processes.length > 0}
			<section class="processes">
				<h2>프로세스 (nvidia-smi)</h2>
				<ul>
					{#each status.processes as p (p.pid)}
						<li>{p.name} (pid {p.pid}) — {p.vram_mb} MB</li>
					{/each}
				</ul>
			</section>
		{/if}

		<footer class="fetched">{new Date(status.fetched_at).toLocaleString()}</footer>
	{/if}
</div>

<style>
	.page { padding: 0; max-width: 720px; }
	.page h1 { margin-top: 0; font-size: 1.1rem; }
	.page h2 { font-size: 0.95rem; margin: 1.25rem 0 0.5rem; }
	.error-banner {
		padding: 0.75rem;
		background: #fee;
		border: 1px solid #fcc;
		border-radius: 4px;
		margin-bottom: 1rem;
	}
	.vram .bar { height: 16px; background: #eee; border-radius: 4px; overflow: hidden; }
	.vram .fill { height: 100%; background: #4a90e2; transition: width 0.3s; }
	.vram-label { margin-top: 0.25rem; font-size: 0.9rem; color: #555; }
	.models ul, .processes ul { list-style: none; padding: 0; margin: 0; }
	.models li, .processes li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
	.row { display: flex; align-items: center; gap: 0.75rem; }
	.row .meta { flex: 1; display: flex; gap: 0.5rem; align-items: baseline; }
	.row .name { font-weight: 600; }
	.row .badge {
		font-size: 0.75rem;
		background: #eef;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
	}
	.row .size { color: #555; font-size: 0.85rem; }
	.row .idle { color: #777; font-size: 0.85rem; }
	.row button { padding: 0.25rem 0.75rem; }
	.empty { color: #888; }
	.fetched { color: #aaa; font-size: 0.75rem; margin-top: 1rem; display: block; }
</style>
