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
	import { appendCommandToTerminalHistory, flushTerminalHistoryNow, removeCommandFromTerminalHistory, clearTerminalHistory, pinCommandInTerminalHistory, unpinCommandInTerminalHistory } from './historyStore.js';
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
	let xtermHostEl: HTMLDivElement | undefined = $state();
	let xtermStageEl: HTMLDivElement | undefined = $state();
	let status: WsClientStatus = $state('connecting');
	let statusMessage: string = $state('');
	let resolvedBridge: string | null = $state(null);
	let bridgeMissing = $state(false);

	let shellIntegrationDetected = $state(false);

	let histories: Map<string, string[]> = $state(new Map());
	let pinneds: Map<string, string[]> = $state(new Map());
	let currentWindowKey: string | null = $state(null);
	let panelOpen = $state(false);
	let isMobile = $state(false);
	let shellHintDismissed = $state(false);
	let shellHintVisible = $state(false);

	// Spectator mode: read-only view of the active tmux pane on the target.
	// Pane id and size are reported by the bridge on first attach + every
	// focus change; rendered in the header so the user knows what they're
	// watching.
	const isSpectator = $derived(!!spec.spectate);
	let spectatorPaneId: string | null = $state(null);
	let spectatorCols = $state(0);
	let spectatorRows = $state(0);
	let spectatorWindowIndex = $state('');
	let spectatorWindowName = $state('');
	// Spectator "보내기" popup — explicit keystroke injection into the
	// active pane. Useful for quick claude-code confirmations (y/n/Enter)
	// from mobile without breaking the read-only-by-default invariant.
	let sendPopupOpen = $state(false);
	let sendPopupText = $state('');
	let sendPopupInput: HTMLInputElement | undefined = $state();

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
		pinneds = parsed?.pinneds ?? new Map();
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
	async function onPanelPin(text: string): Promise<void> {
		await pinCommandInTerminalHistory(guid, text, currentWindowKey ?? undefined);
		await reloadHistory();
	}
	async function onPanelUnpin(text: string): Promise<void> {
		await unpinCommandInTerminalHistory(guid, text, currentWindowKey ?? undefined);
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

	function openSendPopup(): void {
		sendPopupText = '';
		sendPopupOpen = true;
		// Autofocus after the modal renders.
		queueMicrotask(() => sendPopupInput?.focus());
	}
	function closeSendPopup(): void {
		sendPopupOpen = false;
		sendPopupText = '';
	}
	function sendPopupSubmit(autoExecute: boolean): void {
		const text = sendPopupText;
		if (!text && !autoExecute) {
			closeSendPopup();
			return;
		}
		client?.sendCommand(text, autoExecute);
		closeSendPopup();
	}
	/** One-tap injection of a literal key/sequence, bypassing the text field. */
	function sendQuickKey(bytes: string): void {
		client?.send(bytes);
	}

	/**
	 * Width-fit the spectator's xterm using `transform: scale` plus an
	 * explicitly-sized stage wrapper.
	 *
	 * Why not CSS `zoom`: on mobile Safari/Chrome, `zoom` interacts badly
	 * with xterm.js's absolutely-positioned cell spans — glyphs collapse
	 * to the left and rendering breaks at fractional zoom values. It works
	 * on desktop but is unreliable on phones. `transform: scale` is
	 * universally well-behaved.
	 *
	 * Layout strategy:
	 *   - `.xterm-screen` reports the pane's natural pixel dimensions
	 *     (cols × cellW, rows × cellH) — the source of truth for size.
	 *   - `.xterm-mount` gets explicit width/height = natural dimensions
	 *     and `transform: scale(s)` with `top left` origin. It renders
	 *     visually at `naturalW * s × naturalH * s`.
	 *   - `.xterm-stage` is sized at `naturalW * s × naturalH * s` —
	 *     reserves the layout box for `.xterm-host`'s overflow:auto to
	 *     compute scroll bounds. Without this, transform-scaled content
	 *     wouldn't make the host scrollable.
	 *
	 * `min(host_w / naturalW, 1)` — width-fit, never scale up.
	 */
	function applySpectatorFit(): void {
		if (!isSpectator || !xtermContainer || !xtermStageEl || !xtermHostEl) return;
		const screenEl = xtermContainer.querySelector('.xterm-screen') as HTMLElement | null;
		if (!screenEl) return;
		const naturalW = screenEl.offsetWidth;
		const naturalH = screenEl.offsetHeight;
		const hostW = xtermHostEl.clientWidth;
		if (naturalW === 0 || naturalH === 0 || hostW === 0) return;
		const scale = Math.min(hostW / naturalW, 1);
		// Mount: natural size, scaled visually.
		xtermContainer.style.width = `${naturalW}px`;
		xtermContainer.style.height = `${naturalH}px`;
		xtermContainer.style.transformOrigin = 'top left';
		xtermContainer.style.transform = `scale(${scale})`;
		// Stage: layout box at the scaled size so the host's scroll
		// bounds reflect what the user actually sees.
		xtermStageEl.style.width = `${naturalW * scale}px`;
		xtermStageEl.style.height = `${naturalH * scale}px`;
	}

	/**
	 * Pane / window navigation in the spectated tmux session. The bridge
	 * issues `select-pane` / `select-window` on the control channel; the
	 * resulting focus change flows back through the existing
	 * `pane-switch` path so we don't need to handle the response here.
	 */
	function tmuxNav(action: 'next-pane' | 'prev-pane' | 'next-window' | 'prev-window'): void {
		client?.tmuxNav(action);
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

		// Spectator mode skips OSC 133 capture, history wiring, the
		// shell-integration banner, and FitAddon — bridge dictates pane size
		// via pane-switch frames, and no input is sent.
		if (!isSpectator) {

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

		} // end !isSpectator gate for OSC + history + shell-banner setup

		if (!isSpectator) {
			fit = new FitAddon();
			term.loadAddon(fit);
		}
		if (xtermContainer) {
			term.open(xtermContainer);
			if (!isSpectator) {
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
			} else {
				// Same font-ready gotcha applies in spectator mode — natural
				// .xterm dimensions are wrong until the real font measures.
				applySpectatorFit();
				void document.fonts.ready.then(() => applySpectatorFit());
			}
		}

		client = new TerminalWsClient({
			bridge,
			target: spec.target,
			token,
			cols: term.cols,
			rows: term.rows,
			spectate: spec.spectate,
			onData: (chunk) => term?.write(chunk),
			onStatus: (s, info) => {
				status = s;
				if (info?.message) statusMessage = info.message;
				else if (s === 'closed' && info?.code !== undefined) statusMessage = `종료됨 (code ${info.code})`;
				else if (s === 'open') statusMessage = '';
				else if (s === 'connecting') statusMessage = '';
				// Auto-run connect: script only in shell mode.
				if (!isSpectator && s === 'open' && !connectFired) {
					connectFired = true;
					void runConnectScript(spec.connect, (line) => client?.send(line));
				}
			},
			onPaneSwitch: ({ paneId, cols, rows, windowIndex, windowName }) => {
				spectatorPaneId = paneId;
				spectatorCols = cols;
				spectatorRows = rows;
				spectatorWindowIndex = windowIndex;
				spectatorWindowName = windowName;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
				// term.resize triggers an async re-render; defer the fit one
				// frame so .xterm's new natural dimensions have settled.
				requestAnimationFrame(() => applySpectatorFit());
			},
			onPaneResize: ({ cols, rows }) => {
				spectatorCols = cols;
				spectatorRows = rows;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
				requestAnimationFrame(() => applySpectatorFit());
			}
		});
		client.connect();

		if (!isSpectator) {
			bannerTimer = setTimeout(() => {
				if (!shellIntegrationDetected && !shellHintDismissed) {
					shellHintVisible = true;
				}
			}, 30_000);

			term.onResize(({ cols, rows }) => client?.resize(cols, rows));

			// Refit on container size changes (window resize, panel toggles).
			if (xtermContainer) {
				resizeObserver = new ResizeObserver(() => {
					try { fit?.fit(); } catch { /* ignore */ }
				});
				resizeObserver.observe(xtermContainer);
			}
		} else if (xtermHostEl) {
			// Spectator: re-fit on host size changes (rotation, viewport
			// resize, address-bar collapse on mobile).
			resizeObserver = new ResizeObserver(() => applySpectatorFit());
			resizeObserver.observe(xtermHostEl);
		}

		// Keyboard input wiring:
		//   - Shell mode: always send (normal terminal use).
		//   - Spectator on desktop: send — typing into a focused xterm
		//     should feel like a real terminal, so we wire onData
		//     straight through to send-keys on the active pane.
		//   - Spectator on mobile: stays inert. The on-screen keyboard
		//     would pop up on every tap and clobber the read-by-default
		//     experience; explicit input on phones flows through the
		//     보내기 popup instead.
		// `isMobile` is reactive ($state); the closure re-reads it on
		// every call so viewport-breakpoint changes are honored without
		// re-wiring the handler.
		term.onData((data) => {
			if (isSpectator && isMobile) return;
			client?.send(data);
		});
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
			spectate: spec.spectate,
			onData: (chunk) => term?.write(chunk),
			onStatus: (s, info) => {
				status = s;
				if (info?.message) statusMessage = info.message;
				else if (s === 'closed' && info?.code !== undefined) statusMessage = `종료됨 (code ${info.code})`;
				else statusMessage = '';
				if (!isSpectator && s === 'open' && !connectFired) {
					connectFired = true;
					void runConnectScript(spec.connect, (line) => client?.send(line));
				}
			},
			onPaneSwitch: ({ paneId, cols, rows, windowIndex, windowName }) => {
				spectatorPaneId = paneId;
				spectatorCols = cols;
				spectatorRows = rows;
				spectatorWindowIndex = windowIndex;
				spectatorWindowName = windowName;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
			},
			onPaneResize: ({ cols, rows }) => {
				spectatorCols = cols;
				spectatorRows = rows;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
			}
		});
		client.connect();
	}
</script>

<div class="terminal-page" class:panel-open={panelOpen} class:mobile={isMobile} class:spectator={isSpectator}>
	<div class="terminal-header">
		<div class="meta">
			<div class="line"><span class="label">target</span><code>{spec.target}</code></div>
			{#if isSpectator}
				<div class="line">
					<span class="label">관전</span>
					<code>tmux {spec.spectate}{spectatorPaneId ? ` · ${spectatorPaneId}` : ''}{spectatorCols ? ` · ${spectatorCols}×${spectatorRows}` : ''}</code>
				</div>
			{:else if spec.bridge}
				<div class="line"><span class="label">bridge</span><code>{spec.bridge}</code></div>
			{:else if resolvedBridge}
				<div class="line"><span class="label">bridge</span><code class="muted">{resolvedBridge} (기본값)</code></div>
			{/if}
		</div>
		<div class="actions">
			{#if !isSpectator}
				<button type="button" class="toggle" onclick={togglePanel}>
					히스토리 ({currentItems.length})
				</button>
			{/if}
			<span class="status status-{status}">
				{#if status === 'connecting'}연결 중…
				{:else if status === 'open'}{isSpectator ? '관전 중' : '연결됨'}
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
		<!--
			Three-layer DOM for the spectator's width-fit + scroll:
			  .xterm-host  — flex, overflow-y:auto in spectator.
			  .xterm-stage — explicit scaled-pixel dimensions in spectator
			                 so .xterm-host's scrollbar reflects the visual
			                 size of the transformed mount.
			  .xterm-mount — natural cell-based dimensions; xterm.js mounts
			                 here. In spectator, gets transform:scale(s).
			Non-spectator: stage + mount stay 100%×100% (transparent).
		-->
		<div class="xterm-host" bind:this={xtermHostEl}>
			<div class="xterm-stage" bind:this={xtermStageEl}>
				<div class="xterm-mount" bind:this={xtermContainer}></div>
			</div>
		</div>
		{#if panelOpen && !isSpectator}
			<HistoryPanel
				count={currentItems.length}
				items={currentItems}
				pinned={pinneds.get(currentWindowKey ?? '') ?? []}
				bucketLabel={bucketLabel}
				onsend={onPanelSend}
				onsendNow={onPanelSendNow}
				ondelete={onPanelDelete}
				onclear={onPanelClear}
				onclose={onPanelClose}
				{onedit}
				onpin={onPanelPin}
				onunpin={onPanelUnpin}
			/>
		{/if}
	</div>

	{#if isSpectator}
		<div class="spec-footer" role="toolbar" aria-label="관전 도구">
			<div class="spec-windowbar" aria-live="polite">
				{#if spectatorWindowIndex || spectatorWindowName}
					<span class="win-idx">{spectatorWindowIndex}</span>
					<span class="win-name">{spectatorWindowName || '(이름 없음)'}</span>
				{:else}
					<span class="win-placeholder">윈도우 정보 대기 중…</span>
				{/if}
			</div>
			<div class="spec-controls">
				<div class="spec-group">
					<button
						type="button"
						class="icon"
						title="이전 윈도우"
						onclick={() => tmuxNav('prev-window')}
						disabled={status !== 'open'}
					>&laquo;</button>
					<button
						type="button"
						class="icon"
						title="이전 패널"
						onclick={() => tmuxNav('prev-pane')}
						disabled={status !== 'open'}
					>&lsaquo;</button>
					<button
						type="button"
						class="icon"
						title="다음 패널"
						onclick={() => tmuxNav('next-pane')}
						disabled={status !== 'open'}
					>&rsaquo;</button>
					<button
						type="button"
						class="icon"
						title="다음 윈도우"
						onclick={() => tmuxNav('next-window')}
						disabled={status !== 'open'}
					>&raquo;</button>
				</div>
				{#if isMobile}
					<button
						type="button"
						class="send-btn"
						onclick={openSendPopup}
						disabled={status !== 'open'}
						title="활성 패널에 키 입력 전송"
					>보내기</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if sendPopupOpen}
	<div
		class="send-overlay"
		role="presentation"
		onclick={closeSendPopup}
		onkeydown={(e) => { if (e.key === 'Escape') closeSendPopup(); }}
	>
		<div
			class="send-modal"
			role="dialog"
			aria-label="명령 전송"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<div class="send-title">활성 패널로 전송</div>
			<input
				type="text"
				class="send-input"
				bind:this={sendPopupInput}
				bind:value={sendPopupText}
				placeholder="텍스트 입력 (예: continue, y, 한글도 OK)"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				onkeydown={(e) => {
					// `isComposing` is true mid-IME (Korean/Japanese/Chinese
					// composition). The first Enter during composition just
					// commits the candidate — the user then presses Enter
					// again to actually submit. Without this guard, Enter
					// would fire submit on the half-composed text.
					if (e.key === 'Enter' && !e.isComposing) {
						e.preventDefault();
						sendPopupSubmit(true);
					} else if (e.key === 'Escape' && !e.isComposing) {
						e.preventDefault();
						closeSendPopup();
					}
				}}
			/>
			<div class="send-quick">
				<span class="send-quick-label">빠른 키</span>
				<button type="button" onclick={() => sendQuickKey('y\r')}>y ↵</button>
				<button type="button" onclick={() => sendQuickKey('n\r')}>n ↵</button>
				<button type="button" onclick={() => sendQuickKey('1\r')}>1 ↵</button>
				<button type="button" onclick={() => sendQuickKey('\r')}>↵</button>
				<button type="button" onclick={() => sendQuickKey('\x1b')}>Esc</button>
				<button type="button" onclick={() => sendQuickKey('\x03')}>^C</button>
				<button type="button" title="Page Up (TUI 내부 스크롤)" onclick={() => sendQuickKey('\x1b[5~')}>PgUp</button>
				<button type="button" title="Page Down (TUI 내부 스크롤)" onclick={() => sendQuickKey('\x1b[6~')}>PgDn</button>
			</div>
			<div class="send-actions">
				<button type="button" onclick={closeSendPopup}>취소</button>
				<button type="button" onclick={() => sendPopupSubmit(false)}>타이핑만</button>
				<button type="button" class="primary" onclick={() => sendPopupSubmit(true)}>
					엔터로 실행
				</button>
			</div>
		</div>
	</div>
{/if}

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

	/* Spectator bottom toolbar — terminal-specific controls live here so
	   they don't crowd / overlap the top header on a phone. Two-row
	   layout: top strip = current tmux window label, bottom row =
	   nav buttons + 보내기. */
	.spec-footer {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 8px;
		background: #2a2a2a;
		border-top: 1px solid #111;
		flex-shrink: 0;
	}
	.spec-windowbar {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 0.75rem;
		line-height: 1.2;
		color: #aac;
		min-height: 1em;
		min-width: 0;
	}
	.spec-windowbar .win-idx {
		color: #6cf;
		font-weight: 600;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		flex-shrink: 0;
	}
	.spec-windowbar .win-idx::before { content: '['; color: #557; }
	.spec-windowbar .win-idx::after { content: ']'; color: #557; }
	.spec-windowbar .win-name {
		color: #cfe;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.spec-windowbar .win-placeholder { color: #667; font-style: italic; }
	.spec-controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.spec-group {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		background: #1f1f1f;
		border: 1px solid #444;
		border-radius: 5px;
		padding: 2px;
	}
	.spec-footer button {
		background: #3a3a3a;
		color: #ddd;
		border: 1px solid #555;
		border-radius: 4px;
		padding: 4px 8px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.spec-footer button.icon {
		padding: 4px 9px;
		min-width: 30px;
		line-height: 1;
	}
	.spec-footer button:active {
		background: #4a4a4a;
	}
	.spec-footer button:disabled {
		opacity: 0.5;
	}
	.spec-footer .send-btn {
		margin-left: auto;
		background: #1e6f3f;
		border-color: #2b8;
		color: #fff;
		padding: 5px 14px;
		font-weight: 600;
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

	/* Non-spectator: stage and mount stay transparent (full-size),
	   FitAddon sees normal layout. */
	.terminal-page:not(.spectator) .xterm-stage,
	.terminal-page:not(.spectator) .xterm-mount {
		width: 100%;
		height: 100%;
	}

	/* Spectator: width-fit + vertical overflow. transform:scale on the
	   mount is paired with an explicit-pixel stage so the host's
	   overflow-y can compute scroll bounds correctly. Horizontal is
	   always hidden — width fit guarantees no horizontal overflow. */
	.terminal-page.spectator .xterm-host {
		overflow-x: hidden;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}
	.terminal-page.spectator .xterm-stage {
		/* width / height set inline by applySpectatorFit. */
		position: relative;
	}
	.terminal-page.spectator .xterm-mount {
		/* width / height / transform set inline by applySpectatorFit. */
		position: absolute;
		top: 0;
		left: 0;
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

	/* Spectator 보내기 modal */
	.send-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 16px;
	}
	.send-modal {
		background: #2a2a2a;
		color: #ddd;
		border: 1px solid #444;
		border-radius: 8px;
		padding: 14px 14px 12px;
		width: min(420px, 100%);
		display: flex;
		flex-direction: column;
		gap: 10px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
	}
	.send-title {
		font-size: 0.85rem;
		color: #cfe;
	}
	.send-input {
		background: #1e1e1e;
		color: #fff;
		border: 1px solid #555;
		border-radius: 4px;
		padding: 8px 10px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 0.95rem;
		outline: none;
	}
	.send-input:focus {
		border-color: #8af;
	}
	.send-quick {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
	.send-quick-label {
		font-size: 0.72rem;
		color: #888;
		margin-right: 2px;
	}
	.send-quick button {
		background: #3a3a3a;
		color: #ddd;
		border: 1px solid #555;
		border-radius: 4px;
		padding: 4px 9px;
		font-size: 0.78rem;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		cursor: pointer;
	}
	.send-quick button:active {
		background: #4a4a4a;
	}
	.send-actions {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}
	.send-actions button {
		background: #3a3a3a;
		color: #ddd;
		border: 1px solid #555;
		border-radius: 4px;
		padding: 6px 12px;
		font-size: 0.82rem;
		cursor: pointer;
	}
	.send-actions button.primary {
		background: #1e6f3f;
		border-color: #2b8;
		color: #fff;
	}

	/* xterm sets width:100% on its inner viewport but needs a definite
	   block-size container. In non-spectator FitAddon makes the mount
	   match host dimensions, so .xterm fills it; height:100% just makes
	   the contenteditable area extend to the bottom of the viewport.
	   In spectator the mount is sized at natural pixels (set inline),
	   so .xterm fills the mount naturally — no override needed. */
	.terminal-page:not(.spectator) .xterm-host :global(.xterm) {
		height: 100%;
	}
</style>
