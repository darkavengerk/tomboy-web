<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import { TerminalWsClient, type WsClientStatus } from './wsClient.js';
	import type { TerminalNoteSpec } from './parseTerminalNote.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken
	} from './bridgeSettings.js';
	import { Osc133State, parseOsc133Payload, shouldRecordCommand } from './oscCapture.js';
	import { appendCommandToTerminalHistory, flushTerminalHistoryNow, removeCommandFromTerminalHistory, clearTerminalHistory } from './historyStore.js';
	import { runConnectScript } from './connectAutoRun.js';
	import {
		getTerminalHistoryBlocklist,
		getTerminalHistoryPanelOpenDesktop,
		setTerminalHistoryPanelOpenDesktop,
		getTerminalHistoryPanelOpenMobile,
		setTerminalHistoryPanelOpenMobile,
		getTerminalShellIntegrationBannerDismissed,
		setTerminalShellIntegrationBannerDismissed
	} from '$lib/storage/appSettings.js';
	import { subscribeNoteReload } from '$lib/core/noteReloadBus.js';
	import { getNote } from '$lib/storage/noteStore.js';
	import { deserializeContent } from '$lib/core/noteContentArchiver.js';
	import { parseTerminalNote } from './parseTerminalNote.js';
	import HistoryPanel from './HistoryPanel.svelte';

	type Props = {
		spec: TerminalNoteSpec;
		guid: string;
		onedit: () => void;
	};
	let { spec, guid, onedit }: Props = $props();

	let xtermContainer: HTMLDivElement | undefined = $state();
	let status: WsClientStatus = $state('connecting');
	let statusMessage: string = $state('');
	let resolvedBridge: string | null = $state(null);
	let bridgeMissing = $state(false);

	let shellIntegrationDetected = $state(false);

	let histories: Map<string, string[]> = $state(new Map());
	let currentWindowKey: string | null = $state(null);
	let panelOpen = $state(false);
	let isMobile = $state(false);
	let shellHintDismissed = $state(false);
	let shellHintVisible = $state(false);

	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	let client: TerminalWsClient | null = null;
	let resizeObserver: ResizeObserver | null = null;
	let resolvedToken: string | null = null;
	let onPageHide: (() => void) | null = null;
	let unsubReload: (() => void) | null = null;
	let bannerTimer: ReturnType<typeof setTimeout> | null = null;
	let mql: MediaQueryList | null = null;
	let updateMobile: (() => void) | null = null;
	let unmounted = false;
	/**
	 * Guard: connect: commands are sent exactly once per WS-open transition
	 * (initial mount OR intentional reconnect). Set to true after the first
	 * 'open' status fires; reset to false at the start of reconnect() so
	 * clicking 재연결 re-runs the script on the next 'open'.
	 *
	 * NOTE: There is no component-level unit test for this behavior — the
	 * auto-execute logic is covered by connectAutoRun.test.ts, which tests
	 * the pure helper. The guard and wiring are exercised via manual QA.
	 */
	let connectFired = false;

	const currentItems = $derived(histories.get(currentWindowKey ?? '') ?? []);
	const bucketLabel = $derived.by(() => {
		const key = currentWindowKey;
		if (key === null) return '기본';
		return key.replace(/^tmux:/, 'tmux ');
	});

	async function reloadHistory(): Promise<void> {
		if (unmounted) return;
		const note = await getNote(guid);
		if (unmounted) return;
		if (!note) return;
		const doc = deserializeContent(note.xmlContent);
		const parsed = parseTerminalNote(doc);
		histories = parsed?.histories ?? new Map();
	}

	async function togglePanel(): Promise<void> {
		panelOpen = !panelOpen;
		if (isMobile) await setTerminalHistoryPanelOpenMobile(panelOpen);
		else await setTerminalHistoryPanelOpenDesktop(panelOpen);
	}

	function onPanelSend(text: string): void {
		client?.sendCommand(text, false);
		term?.focus();
	}
	function onPanelSendNow(text: string): void {
		client?.sendCommand(text, true);
		term?.focus();
	}
	async function onPanelDelete(index: number): Promise<void> {
		await removeCommandFromTerminalHistory(guid, index, currentWindowKey ?? undefined);
		await reloadHistory();
	}
	async function onPanelClear(): Promise<void> {
		await clearTerminalHistory(guid, currentWindowKey ?? undefined);
		await reloadHistory();
	}
	function onPanelClose(): void {
		void togglePanel();
	}
	async function dismissShellHint(): Promise<void> {
		shellHintVisible = false;
		shellHintDismissed = true;
		await setTerminalShellIntegrationBannerDismissed(true);
	}

	onMount(async () => {
		mql = window.matchMedia ? window.matchMedia('(min-width: 768px)') : null;
		updateMobile = () => { isMobile = !(mql?.matches ?? true); };
		updateMobile();
		mql?.addEventListener('change', updateMobile);
		panelOpen = isMobile
			? await getTerminalHistoryPanelOpenMobile()
			: await getTerminalHistoryPanelOpenDesktop();
		shellHintDismissed = await getTerminalShellIntegrationBannerDismissed();
		await reloadHistory();
		if (unmounted) return;
		unsubReload = subscribeNoteReload(guid, () => {
			if (unmounted) return;
			void reloadHistory();
		});

		const bridge = spec.bridge ?? (await getDefaultTerminalBridge());
		if (!bridge) {
			bridgeMissing = true;
			status = 'error';
			statusMessage = '브릿지 URL이 설정되지 않았습니다. 설정에서 기본 브릿지를 입력하거나, 노트 두 번째 줄에 `bridge: wss://...` 를 추가하세요.';
			return;
		}
		resolvedBridge = bridge;
		const token = await getTerminalBridgeToken();
		if (!token) {
			status = 'error';
			statusMessage = '브릿지에 로그인하지 않았습니다. 설정 → 동기화 설정 → 터미널 브릿지에서 로그인하세요.';
			return;
		}
		resolvedToken = token;

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

		const osc = new Osc133State();
		const blocklist: string[] = await getTerminalHistoryBlocklist();

		term.parser.registerOscHandler(133, (data: string) => {
			const evt = parseOsc133Payload(data);
			if (!evt) return false; // let xterm render — defensive; unknown payloads
			if (!shellIntegrationDetected) shellIntegrationDetected = true;
			if (evt.kind === 'A') {
				osc.onPromptStart();
			} else if (evt.kind === 'B') {
				const buf = term!.buffer.active;
				osc.onCommandStart(buf.cursorY + buf.baseY, buf.cursorX);
			} else if (evt.kind === 'C') {
				const buf = term!.buffer.active;
				const scraped = osc.consumeCommandOnExecute(
					buf.cursorY + buf.baseY,
					buf.cursorX,
					(row) => {
						const line = buf.getLine(row);
						return line ? line.translateToString(true) : '';
					}
				);
				const cmd = evt.commandText !== undefined ? evt.commandText : scraped;
				// winId present → inside tmux; absent → outside tmux (or
				// tmux-unaware shell). Reset on absence so commands run after
				// `tmux exit` go to the non-tmux bucket instead of bleeding
				// into the last-attached window's bucket.
				currentWindowKey = evt.windowId ? 'tmux:' + evt.windowId : null;
				if (cmd && shouldRecordCommand(cmd, blocklist)) {
					appendCommandToTerminalHistory(guid, cmd, currentWindowKey ?? undefined);
				}
			} else if (evt.kind === 'W') {
				// PS1 emits W on every prompt: with id while inside tmux,
				// bare otherwise. This single signal handles every tmux
				// start/exit/attach/window-change case automatically.
				currentWindowKey = evt.windowId ? 'tmux:' + evt.windowId : null;
			}
			// kind 'D' is ignored for now.
			return true; // suppress xterm output of the OSC sequence
		});

		onPageHide = () => { void flushTerminalHistoryNow(guid); };
		window.addEventListener('pagehide', onPageHide);

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
			token,
			cols: term.cols,
			rows: term.rows,
			onData: (chunk) => term?.write(chunk),
			onStatus: (s, info) => {
				status = s;
				if (info?.message) statusMessage = info.message;
				else if (s === 'closed' && info?.code !== undefined) statusMessage = `종료됨 (code ${info.code})`;
				else if (s === 'open') statusMessage = '';
				else if (s === 'connecting') statusMessage = '';
				if (s === 'open' && !connectFired) {
					connectFired = true;
					void runConnectScript(spec.connect, (line) => client?.send(line));
				}
			}
		});
		client.connect();

		bannerTimer = setTimeout(() => {
			if (!shellIntegrationDetected && !shellHintDismissed) {
				shellHintVisible = true;
			}
		}, 30_000);

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
		unmounted = true;
		if (bannerTimer) {
			clearTimeout(bannerTimer);
			bannerTimer = null;
		}
		if (mql && updateMobile) {
			mql.removeEventListener('change', updateMobile);
		}
		mql = null;
		updateMobile = null;
		unsubReload?.();
		unsubReload = null;
		if (onPageHide) {
			window.removeEventListener('pagehide', onPageHide);
			onPageHide = null;
		}
		// Best-effort flush so commands captured shortly before navigation aren't lost.
		void flushTerminalHistoryNow(guid);
		resizeObserver?.disconnect();
		resizeObserver = null;
		client?.close();
		client = null;
		term?.dispose();
		term = null;
		fit = null;
	});

	function reconnect() {
		if (!resolvedBridge || !resolvedToken) return;
		connectFired = false; // allow connect: script to re-run on next 'open'
		client?.close();
		term?.reset();
		status = 'connecting';
		statusMessage = '';
		client = new TerminalWsClient({
			bridge: resolvedBridge,
			target: spec.target,
			token: resolvedToken,
			cols: term?.cols ?? 80,
			rows: term?.rows ?? 24,
			onData: (chunk) => term?.write(chunk),
			onStatus: (s, info) => {
				status = s;
				if (info?.message) statusMessage = info.message;
				else if (s === 'closed' && info?.code !== undefined) statusMessage = `종료됨 (code ${info.code})`;
				else statusMessage = '';
				if (s === 'open' && !connectFired) {
					connectFired = true;
					void runConnectScript(spec.connect, (line) => client?.send(line));
				}
			}
		});
		client.connect();
	}
</script>

<div class="terminal-page" class:panel-open={panelOpen} class:mobile={isMobile}>
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
			<button type="button" class="toggle" onclick={togglePanel}>
				히스토리 ({currentItems.length})
			</button>
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

	{#if shellHintVisible}
		<div class="banner banner-hint">
			셸 통합이 감지되지 않았습니다. 명령어가 자동으로 기록되지 않습니다.
			<a href="/settings#terminal" target="_self">설정 안내 보기</a>
			<button type="button" class="banner-close" onclick={dismissShellHint}>×</button>
		</div>
	{/if}

	<div class="body">
		<div class="xterm-host" bind:this={xtermContainer}></div>
		{#if panelOpen}
			<HistoryPanel
				count={currentItems.length}
				items={currentItems}
				bucketLabel={bucketLabel}
				onsend={onPanelSend}
				onsendNow={onPanelSendNow}
				ondelete={onPanelDelete}
				onclear={onPanelClear}
				onclose={onPanelClose}
				{onedit}
			/>
		{/if}
	</div>
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

	.actions .toggle {
		background: #3a3a3a;
		color: #ddd;
		border: 1px solid #555;
		border-radius: 4px;
		padding: 3px 8px;
		font-size: 0.78rem;
		cursor: pointer;
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

	.banner-hint {
		background: #3a3a4a;
		color: #ddd;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.banner-hint a { color: #9bf; }
	.banner-close {
		margin-left: auto;
		background: transparent;
		border: none;
		color: #aaa;
		cursor: pointer;
		font-size: 1rem;
	}

	.body {
		flex: 1;
		display: flex;
		min-height: 0;
	}

	/* Desktop (default): panel on the right */
	.body :global(.history-panel) {
		width: 240px;
		flex-shrink: 0;
	}

	.xterm-host {
		flex: 1;
		padding: 4px;
		overflow: hidden;
	}

	/* Mobile: panel becomes a bottom sheet ~50% height */
	.terminal-page.mobile.panel-open .body {
		flex-direction: column;
	}
	.terminal-page.mobile.panel-open .xterm-host {
		flex: 1 1 50%;
		min-height: 0;
	}
	.terminal-page.mobile.panel-open .body :global(.history-panel) {
		width: auto;
		flex: 1 1 50%;
		border-left: none;
		border-top: 1px solid #111;
	}

	/* xterm sets width:100% on its inner viewport but needs a definite
	   block-size container — flex:1 above gives that. */
	.xterm-host :global(.xterm) {
		height: 100%;
	}
</style>
