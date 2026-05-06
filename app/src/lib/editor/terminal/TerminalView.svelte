<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import { TerminalWsClient, type WsClientStatus } from './wsClient.js';
	import type { TerminalNoteSpec } from './parseTerminalNote.js';
	import { getDefaultTerminalBridge } from './bridgeSettings.js';

	type Props = {
		spec: TerminalNoteSpec;
		onedit: () => void;
	};
	let { spec, onedit }: Props = $props();

	let xtermContainer: HTMLDivElement | undefined = $state();
	let status: WsClientStatus = $state('connecting');
	let statusMessage: string = $state('');
	let resolvedBridge: string | null = $state(null);
	let bridgeMissing = $state(false);

	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	let client: TerminalWsClient | null = null;
	let resizeObserver: ResizeObserver | null = null;

	onMount(async () => {
		const bridge = spec.bridge ?? (await getDefaultTerminalBridge());
		if (!bridge) {
			bridgeMissing = true;
			status = 'error';
			statusMessage = '브릿지 URL이 설정되지 않았습니다. 설정에서 기본 브릿지를 입력하거나, 노트 두 번째 줄에 `bridge: wss://...` 를 추가하세요.';
			return;
		}
		resolvedBridge = bridge;

		term = new Terminal({
			// Linux first (DejaVu/Liberation ship on most distros incl. Bazzite),
			// then macOS/Windows, then the generic keyword. xterm.js measures
			// 'M' to derive cell width — if the named font is missing the
			// browser falls back to a proportional font and cells come out
			// twice as wide as the actual glyphs.
			fontFamily: '"DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, ui-monospace, monospace',
			fontSize: 14,
			letterSpacing: 0,
			cursorBlink: true,
			theme: { background: '#1e1e1e' },
			scrollback: 5000,
			convertEol: false
		});
		fit = new FitAddon();
		term.loadAddon(fit);
		if (xtermContainer) {
			term.open(xtermContainer);
			// Wait for the real font to load before measuring — otherwise
			// cell width is computed against the fallback (often a
			// proportional font) and every glyph gets ~one extra cell of
			// trailing space.
			const refit = () => { try { fit?.fit(); } catch { /* ignore */ } };
			refit();
			void document.fonts.ready.then(() => {
				refit();
				if (term && client) client.resize(term.cols, term.rows);
			});
		}

		client = new TerminalWsClient({
			bridge,
			target: spec.target,
			cols: term.cols,
			rows: term.rows,
			onData: (chunk) => term?.write(chunk),
			onStatus: (s, info) => {
				status = s;
				if (info?.message) statusMessage = info.message;
				else if (s === 'closed' && info?.code !== undefined) statusMessage = `종료됨 (code ${info.code})`;
				else if (s === 'open') statusMessage = '';
				else if (s === 'connecting') statusMessage = '';
			}
		});
		client.connect();

		term.onData((data) => client?.send(data));
		term.onResize(({ cols, rows }) => client?.resize(cols, rows));

		// Refit on container size changes (window resize, panel toggles).
		if (xtermContainer) {
			resizeObserver = new ResizeObserver(() => {
				try { fit?.fit(); } catch { /* ignore */ }
			});
			resizeObserver.observe(xtermContainer);
		}
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		resizeObserver = null;
		client?.close();
		client = null;
		term?.dispose();
		term = null;
		fit = null;
	});

	function reconnect() {
		if (!resolvedBridge) return;
		client?.close();
		term?.reset();
		status = 'connecting';
		statusMessage = '';
		client = new TerminalWsClient({
			bridge: resolvedBridge,
			target: spec.target,
			cols: term?.cols ?? 80,
			rows: term?.rows ?? 24,
			onData: (chunk) => term?.write(chunk),
			onStatus: (s, info) => {
				status = s;
				if (info?.message) statusMessage = info.message;
				else if (s === 'closed' && info?.code !== undefined) statusMessage = `종료됨 (code ${info.code})`;
				else statusMessage = '';
			}
		});
		client.connect();
	}
</script>

<div class="terminal-page">
	<div class="terminal-header">
		<div class="meta">
			<div class="line"><span class="label">target</span><code>{spec.target}</code></div>
			{#if spec.bridge}
				<div class="line"><span class="label">bridge</span><code>{spec.bridge}</code></div>
			{:else if resolvedBridge}
				<div class="line"><span class="label">bridge</span><code class="muted">{resolvedBridge} (기본값)</code></div>
			{/if}
		</div>
		<div class="actions">
			<span class="status status-{status}">
				{#if status === 'connecting'}연결 중…
				{:else if status === 'open'}연결됨
				{:else if status === 'closed'}끊김
				{:else}오류{/if}
			</span>
			<button type="button" onclick={reconnect} disabled={!resolvedBridge}>재연결</button>
			<button type="button" onclick={onedit}>편집 모드</button>
		</div>
	</div>

	{#if statusMessage}
		<div class="banner" class:banner-error={status === 'error' || bridgeMissing}>{statusMessage}</div>
	{/if}

	<div class="xterm-host" bind:this={xtermContainer}></div>
</div>

<style>
	.terminal-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: #1e1e1e;
		color: #ddd;
	}

	.terminal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 10px;
		background: #2a2a2a;
		border-bottom: 1px solid #111;
		font-size: 0.78rem;
	}

	.meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.line {
		display: flex;
		gap: 6px;
		align-items: baseline;
		min-width: 0;
	}

	.label {
		color: #888;
		flex-shrink: 0;
	}

	code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		color: #cfe;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	code.muted { color: #889; }

	.actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.actions button {
		background: #3a3a3a;
		color: #ddd;
		border: 1px solid #555;
		border-radius: 4px;
		padding: 3px 8px;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.status {
		font-size: 0.72rem;
		padding: 2px 6px;
		border-radius: 3px;
		background: #444;
	}
	.status-open { background: #1e6f3f; color: #c8f7d4; }
	.status-connecting { background: #6f5e1e; color: #f7eec8; }
	.status-closed { background: #555; color: #ddd; }
	.status-error { background: #6f1e1e; color: #f7c8c8; }

	.banner {
		padding: 6px 10px;
		font-size: 0.78rem;
		background: #3a2a2a;
		color: #f7c8c8;
	}

	.banner-error { background: #5a1e1e; }

	.xterm-host {
		flex: 1;
		padding: 4px;
		overflow: hidden;
	}

	/* xterm sets width:100% on its inner viewport but needs a definite
	   block-size container — flex:1 above gives that. */
	.xterm-host :global(.xterm) {
		height: 100%;
	}
</style>
