<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import { TerminalWsClient, type WsClientStatus, type PaneSwitchInfo } from './wsClient.js';
	import type { TerminalNoteSpec } from './parseTerminalNote.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken,
		fetchSessions,
		type SessionInfo
	} from './bridgeSettings.js';
	import { Osc133State, parseOsc133Payload, shouldRecordCommand } from './oscCapture.js';
	import { appendCommandToTerminalHistory, flushTerminalHistoryNow, removeCommandFromTerminalHistory, clearTerminalHistory, pinCommandInTerminalHistory, unpinCommandInTerminalHistory } from './historyStore.js';
	import { runConnectScript } from './connectAutoRun.js';
	import {
		accumulateTouchScroll,
		computeAnchorRows,
		computeScrollState,
		INITIAL_SCROLL_STATE,
		type SpectatorScrollState
	} from './spectatorScroll.js';
	import {
		getTerminalHistoryBlocklist,
		getTerminalHistoryPanelOpenDesktop,
		setTerminalHistoryPanelOpenDesktop,
		getTerminalHistoryPanelOpenMobile,
		setTerminalHistoryPanelOpenMobile,
		getTerminalShellIntegrationBannerDismissed,
		setTerminalShellIntegrationBannerDismissed,
		getTerminalBellEnabled
	} from '$lib/storage/appSettings.js';
	import { createBellRinger } from './terminalBell.js';
	import { subscribeNoteReload } from '$lib/core/noteReloadBus.js';
	import { getNote, putNote } from '$lib/storage/noteStore.js';
	import { noteMutated } from '$lib/stores/noteListCache.js';
	import { deserializeContent } from '$lib/core/noteContentArchiver.js';
	import { parseTerminalNote, rewriteSpectateLine } from './parseTerminalNote.js';
	import { type StickyMods, computeStickyKeySequence, applyStickyToText } from './stickyMods.js';
	import {
		INITIAL_DOUBLE_TAP_STATE,
		modKeyFromEventKey,
		onModKeydown as onStickyModKeydown,
		onModKeyup as onStickyModKeyup,
		onNonModKeydown as onStickyNonModKeydown,
		type DoubleTapState
	} from './stickyDoubleTap.js';
	import { formatTomboyDate } from '$lib/core/note.js';
	import HistoryPanel from './HistoryPanel.svelte';
	import {
		extractImageFile,
		imageFilesFromList,
		fileToImagePayload,
		validateImageFile
	} from './imagePasteClient.js';
	import { extractImageFromClipboardItems } from './clipboardImage.js';
	import { pushToast } from '$lib/stores/toast.js';

	type Props = {
		spec: TerminalNoteSpec;
		guid: string;
		onedit: () => void;
	};
	let { spec, guid, onedit }: Props = $props();

	let pageEl: HTMLDivElement | undefined = $state();
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
	const isSpectator = $derived(!!spec.spectate || !!spec.spectatePicker);
	let spectatorPaneId: string | null = $state(null);
	let spectatorCols = $state(0);
	let spectatorRows = $state(0);
	let spectatorWindowIndex = $state('');
	let spectatorWindowName = $state('');
	// Active pane's footer-button ordinal (1-based) + the window's pane count,
	// reported by the bridge on every pane-switch. Ordinal 0 = unknown (or the
	// active pane is past button 5). Count 0 = no info yet / bridge too old to
	// send it — the footer then leaves all five buttons enabled.
	let spectatorPaneOrdinal = $state(0);
	let spectatorPaneCount = $state(0);
	/**
	 * Pinned pane ordinal (1..5). When non-null, the spectator subscribes
	 * directly to this pane's output stream (bridge handles independent
	 * live streams per-subscription). Initial value comes from
	 * `spec.pinnedPane` (parsed from `spectate: <s>:<N>`); subsequent
	 * updates are user-driven via the footer toggle, so capturing only
	 * the initial spec value here is intentional.
	 */
	// svelte-ignore state_referenced_locally
	let pinnedOrdinal: number | null = $state(spec.pinnedPane ?? null);
	/**
	 * Non-null when the bridge reports that the pinned ordinal exceeds the
	 * current window's pane count (pane-unavailable frame).
	 */
	let pinUnavailableInfo = $state<{ pinnedOrdinal: number; paneCount: number } | null>(null);
	// Spectator "보내기" popup — explicit keystroke injection into the
	// active pane. Useful for quick claude-code confirmations (y/n/Enter)
	// from mobile without breaking the read-only-by-default invariant.
	let sendPopupOpen = $state(false);
	let sendPopupText = $state('');
	let sendPopupInput: HTMLInputElement | undefined = $state();

	// 세션 피커(런처) — 빈 spectate: 노트. 선택은 휘발(노트 본문 불변).
	// 고정 세션 노트(spec.spectate 있음)는 이 분기를 절대 타지 않는다 —
	// spec.spectatePicker 가 undefined 이므로 awaitingPick/세션 변경 버튼이 죽고
	// effectiveSession 은 항상 spec.spectate 로 떨어진다.
	let selectedSession = $state<string | null>(null);
	const effectiveSession = $derived(spec.spectate ?? selectedSession ?? undefined);
	const awaitingPick = $derived(!!spec.spectatePicker && !selectedSession);
	let pickerOpen = $state(false);
	let pickerLoading = $state(false);
	let pickerError = $state('');
	let pickerSessions = $state<SessionInfo[]>([]);
	let pickerCloseBtn: HTMLButtonElement | undefined = $state();

	// Sticky modifier chips (관전 모드 전용) — buttons in the footer arm
	// modifier(s) that apply to the next key press (desktop keydown
	// branch) or the first byte of the next popup text submit (mobile).
	// See ./stickyMods.ts for the key→byte mapping.
	let stickyMods = $state<StickyMods>({ ctrl: false, alt: false, shift: false });

	function toggleStickyMod(mod: keyof StickyMods): void {
		stickyMods = { ...stickyMods, [mod]: !stickyMods[mod] };
	}

	function resetStickyMods(): void {
		stickyMods = { ctrl: false, alt: false, shift: false };
	}

	// 더블탭으로 sticky 칩을 토글하는 단축키 상태머신. Ctrl/Alt/Shift 중
	// 하나를 단독으로 두 번 연속 누르면 해당 칩이 토글된다. 클릭과 동일한
	// 효과 — armed 상태에서 다시 더블탭하면 해제. See ./stickyDoubleTap.ts.
	let doubleTapState: DoubleTapState = INITIAL_DOUBLE_TAP_STATE;

	// 이미지 붙여넣기 (셸·관전 모드 모두). imageUploadCount > 0 → "업로드 중" 표시.
	let imageUploadCount = $state(0);
	let imageFileInput: HTMLInputElement | undefined = $state();

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
	let scrollState: SpectatorScrollState = $state(INITIAL_SCROLL_STATE);

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
		if (pinnedOrdinal !== null) client?.selectPane(pinnedOrdinal);

		const anyArmed = stickyMods.ctrl || stickyMods.alt || stickyMods.shift;

		if (text.length > 0 && anyArmed) {
			const transformed = applyStickyToText(text, stickyMods);
			if (transformed !== null) {
				client?.send(autoExecute ? transformed + '\r' : transformed);
				resetStickyMods();
				closeSendPopup();
				return;
			}
			// 첫 글자 비대응 → 원본 전송, sticky 유지 (아래 default path로)
		}

		// 빈 텍스트 + autoExecute + Alt만 armed → \x1b\r
		if (!text && autoExecute && stickyMods.alt && !stickyMods.ctrl && !stickyMods.shift) {
			client?.send('\x1b\r');
			resetStickyMods();
			closeSendPopup();
			return;
		}

		client?.sendCommand(text, autoExecute);
		closeSendPopup();
	}
	/** One-tap injection of a literal key/sequence, bypassing the text field. */
	function sendQuickKey(bytes: string): void {
		if (pinnedOrdinal !== null) client?.selectPane(pinnedOrdinal);
		client?.send(bytes);
	}

	/** 이미지 File 하나를 검증 후 브릿지로 전송. */
	async function sendImageFile(file: File): Promise<void> {
		if (pinnedOrdinal !== null) client?.selectPane(pinnedOrdinal);
		const v = validateImageFile(file);
		if (!v.ok) {
			pushToast(v.error ?? '이미지를 보낼 수 없습니다.', { kind: 'error' });
			return;
		}
		if (!client || status !== 'open') {
			pushToast('터미널이 연결되어 있지 않습니다.', { kind: 'error' });
			return;
		}
		imageUploadCount += 1;
		try {
			const payload = await fileToImagePayload(file);
			client.sendImage(payload);
		} catch (err) {
			imageUploadCount = Math.max(0, imageUploadCount - 1);
			pushToast((err as Error).message, { kind: 'error' });
		}
	}

	/** 헤더 "이미지" 버튼 → 숨겨진 파일 입력 열기. */
	function openImagePicker(): void {
		imageFileInput?.click();
	}

	/** 파일 입력 onchange — 고른 이미지들을 모두 전송. */
	function onImageFilePicked(e: Event): void {
		const input = e.currentTarget as HTMLInputElement;
		for (const f of imageFilesFromList(input.files ?? [])) void sendImageFile(f);
		input.value = ''; // 같은 파일을 다시 고를 수 있게 리셋
	}

	/** Ctrl+V 등 붙여넣기 — 클립보드에 이미지가 있으면 가로채 전송. */
	function handleImagePaste(e: ClipboardEvent): void {
		const file = extractImageFile(e.clipboardData);
		if (!file) return; // 이미지 없음 → xterm의 기본 텍스트 붙여넣기에 맡김
		e.preventDefault();
		e.stopPropagation();
		void sendImageFile(file);
	}

	/** 보내기 팝업의 텍스트 입력에 paste된 이미지를 가로챈다. */
	function onSendPopupPaste(e: ClipboardEvent): void {
		const file = extractImageFile(e.clipboardData);
		if (!file) return; // 이미지 없음 → 평문 paste fall-through
		e.preventDefault();
		void sendImageFile(file);
	}

	/** "📋 이미지 붙여넣기" 버튼 — navigator.clipboard.read() 시도. */
	async function onClickPasteImage(): Promise<void> {
		if (!navigator.clipboard || !navigator.clipboard.read) {
			pushToast('이 브라우저는 클립보드 읽기를 지원하지 않습니다.', { kind: 'error' });
			return;
		}
		try {
			const items = await navigator.clipboard.read();
			const file = await extractImageFromClipboardItems(items);
			if (file) {
				void sendImageFile(file);
			} else {
				pushToast('클립보드에 이미지가 없습니다.', { kind: 'error' });
			}
		} catch (err) {
			const name = (err as Error).name;
			pushToast(
				name === 'NotAllowedError'
					? '클립보드 접근 권한이 거부되었습니다.'
					: '클립보드를 읽을 수 없습니다.',
				{ kind: 'error' }
			);
		}
	}

	/** dragover — drop을 허용하려면 preventDefault 필요. */
	function handleImageDragOver(e: DragEvent): void {
		e.preventDefault();
	}

	/** drop — 드롭된 이미지 파일을 모두 전송. */
	function handleImageDrop(e: DragEvent): void {
		e.preventDefault();
		const files = imageFilesFromList(e.dataTransfer?.files ?? []);
		for (const f of files) void sendImageFile(f);
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
	 *   - `.xterm-stage` is sized at `naturalW * s × <stage_h>` —
	 *     reserves the layout box so `.xterm-host`'s dimensions and
	 *     `clientWidth` reflect the scaled footprint, preventing clipping
	 *     of the transformed content.
	 *
	 * `min(host_w / naturalW, 1)` — width-fit, never scale up.
	 *
	 * Bottom-anchor for shell mode: when (1) we're rendering the live
	 * main screen (not an alt-screen TUI) and (2) the user hasn't
	 * scrolled into history, the stage height is set to
	 * `n × cellH × scale` where `n` is the number of meaningful rows
	 * (cursor + non-empty range). The host's `justify-content: flex-end`
	 * anchors the shortened stage to the bottom, so cursor sits at the
	 * bottom of the viewport — matching a real terminal feel. The mount
	 * stays at natural height; stage's `overflow:hidden` clips the
	 * trailing blank rows. For alt-screen TUIs or scrolled-up reading,
	 * stage stays at full `naturalH × scale` so the entire pane shows.
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
		const stageH = computeStageHeight(naturalH, scale);
		xtermStageEl.style.width = `${naturalW * scale}px`;
		xtermStageEl.style.height = `${stageH}px`;
	}

	/**
	 * 셸 모드 + 라이브 맨 아래 고정일 때 콘텐츠 행 수만큼 stage 를 축소한다.
	 * 그 외 (alt-screen TUI / 사용자가 스크롤백 위로 올린 상태) 는 전체 패널
	 * 높이를 그대로 쓴다.
	 *
	 * `alternate` 판정은 xterm 내부 버퍼 타입을 직접 보기 때문에 (브릿지의
	 * pane-switch.altScreen 스냅샷이 아닌) 같은 패널에서 vim 시작/종료처럼
	 * DECSET 1049 토글이 일어나도 다음 데이터 콜백에서 즉시 반영된다.
	 */
	function computeStageHeight(naturalH: number, scale: number): number {
		if (!term) return naturalH * scale;
		const isAlt = term.buffer.active.type === 'alternate';
		if (isAlt || !scrollState.atBottom) return naturalH * scale;
		const R = term.rows;
		if (R <= 0) return naturalH * scale;
		const buf = term.buffer.active;
		const viewportY = buf.viewportY;
		const n = computeAnchorRows({
			rows: R,
			cursorY: buf.cursorY,
			isRowEmpty: (row) => {
				const line = buf.getLine(viewportY + row);
				if (!line) return true;
				return line.translateToString(true).trim().length === 0;
			}
		});
		const cellH = naturalH / R;
		return n * cellH * scale;
	}

	/** 관전 모드 스크롤 상태를 xterm 버퍼 좌표로부터 갱신한다. */
	function recomputeScroll(): void {
		if (!isSpectator || !term) return;
		const b = term.buffer.active;
		scrollState = computeScrollState(scrollState, b.viewportY, b.baseY);
	}

	/** pane-switch 프레임에서 공통으로 갱신되는 7개 spectator 상태 변수를 한꺼번에 씁니다. */
	function applyPaneSwitch({ paneId, cols, rows, windowIndex, windowName, paneOrdinal, paneCount }: PaneSwitchInfo): void {
		spectatorPaneId = paneId;
		spectatorCols = cols;
		spectatorRows = rows;
		spectatorWindowIndex = windowIndex;
		spectatorWindowName = windowName;
		spectatorPaneOrdinal = paneOrdinal;
		spectatorPaneCount = paneCount;
	}

	/** 재연결 시 이전 세션의 패인 정보가 잠시 남아 있지 않도록 spectator 상태를 초기화합니다. */
	function resetSpectatorState(): void {
		spectatorPaneId = null;
		spectatorCols = 0;
		spectatorRows = 0;
		spectatorWindowIndex = '';
		spectatorWindowName = '';
		spectatorPaneOrdinal = 0;
		spectatorPaneCount = 0;
	}

	/*
	 * 모바일 관전 터치 스크롤. xterm v6 자체 터치 스크롤 제스처는 관전 모드의
	 * `transform: scale` 안에서 화면 픽셀↔버퍼 좌표가 어긋나 동작하지 않는다
	 * (데스크탑 휠은 버블링으로 xterm 휠 핸들러에 닿아 멀쩡). 그래서 모바일
	 * 관전에서는 터치 드래그를 직접 term.scrollLines() 로 환산한다 — 휠과 같은
	 * 프로그래매틱 경로라 transform 의 영향을 받지 않는다. 줄 환산·잔차 누적은
	 * accumulateTouchScroll 순수 헬퍼가 맡고, CSS `touch-action: none`(모바일
	 * 관전 .xterm-host)이 브라우저 네이티브 제스처를 끄므로 preventDefault 불필요.
	 */
	let touchLastY: number | null = null;
	let touchScrollRemainder = 0;

	function onSpectatorTouchStart(e: TouchEvent): void {
		if (!isSpectator || !isMobile || e.touches.length !== 1) {
			touchLastY = null;
			return;
		}
		touchLastY = e.touches[0].clientY;
		touchScrollRemainder = 0;
	}

	function onSpectatorTouchMove(e: TouchEvent): void {
		if (touchLastY === null || !term || !xtermContainer) return;
		if (e.touches.length !== 1) {
			touchLastY = null;
			return;
		}
		const y = e.touches[0].clientY;
		const deltaPx = y - touchLastY;
		touchLastY = y;
		// 한 줄당 화면 픽셀 = (스케일된 mount 높이) / term.rows.
		// stage 는 셸 모드에서 콘텐츠 분량으로 축소되므로 stage.clientHeight 로
		// 역산하면 안 된다 — mount 의 getBoundingClientRect 는 transform 을
		// 반영한 실제 시각 픽셀이라 셀 높이의 진짜 값을 준다.
		const mountRect = xtermContainer.getBoundingClientRect();
		const pxPerLine = mountRect.height / term.rows;
		const { lines, remainder } = accumulateTouchScroll(touchScrollRemainder, deltaPx, pxPerLine);
		touchScrollRemainder = remainder;
		// 손가락을 아래로 끌면 과거(위쪽) 출력이 드러나야 하므로 scrollLines 는 음수.
		if (lines !== 0) term.scrollLines(-lines);
	}

	function onSpectatorTouchEnd(): void {
		touchLastY = null;
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

	/**
	 * Jump the spectated window's active pane to pane number `n` (1-based).
	 * Backs the footer's 1/2/3/4 buttons. The bridge resolves the ordinal
	 * against `list-panes`, so a number past the last pane is a no-op.
	 */
	function selectPane(n: number): void {
		client?.selectPane(n);
	}

	/**
	 * Footer pane-button click router. Three branches:
	 *  - 자물쇠 버튼 (n === pinnedOrdinal) → 고정 해제.
	 *  - pin 없음 + 클릭한 번호가 이미 active → 그 번호로 고정.
	 *  - 그 외 → 일반 select-pane(n).
	 *
	 * pin 활성 + 다른 번호 클릭은 footer가 disabled로 막아 여기까지 안 옴.
	 * 토글 시 persistPinToNote()로 노트의 spectate: 라인을 즉시 갱신한다.
	 */
	async function onPaneNumClick(n: number): Promise<void> {
		if (pinnedOrdinal === n) {
			// Unpin: subscribe back to active pane (ordinal 0 = follow-active)
			pinnedOrdinal = null;
			client?.subscribePane(0);
			await persistPinToNote(null);
			return;
		}
		if (pinnedOrdinal === null && n === spectatorPaneOrdinal) {
			// Pin to this pane
			pinnedOrdinal = n;
			client?.subscribePane(n);
			await persistPinToNote(n);
			return;
		}
		client?.selectPane(n);
	}

	/**
	 * Persist the current pin state to the note by rewriting its `spectate:`
	 * line. Called on every lock-icon toggle. `putNote` marks the note dirty
	 * so Dropbox sync uploads on next manual sync; Firebase realtime sync
	 * isn't triggered (no `notifyNoteSaved(guid)` call — that's only from
	 * `noteManager.updateNoteFromEditor`), so cross-device pin propagation
	 * waits for either a Dropbox round-trip or the other device opening
	 * the note. Acceptable since pin is a per-device viewer pref.
	 *
	 * If the note no longer has a spectate: line (user removed it manually),
	 * rewriteSpectateLine returns the input unchanged — we surface a toast and
	 * keep in-memory pin so the user isn't silently betrayed.
	 */
	async function persistPinToNote(n: number | null): Promise<void> {
		const sessionName = spec.spectate;
		if (!sessionName) return; // shouldn't happen — pin is spectator-only
		const note = await getNote(guid);
		if (!note) return;
		const updated = rewriteSpectateLine(note.xmlContent, sessionName, n);
		if (updated === note.xmlContent) {
			pushToast('고정을 저장할 수 없습니다 (노트 형식이 바뀌었습니다)', { kind: 'error' });
			return;
		}
		const now = formatTomboyDate(new Date());
		const stored = {
			...note,
			xmlContent: updated,
			changeDate: now,
			metadataChangeDate: now
		};
		await putNote(stored);
		// Bypasses noteManager — patch the warm shared cache ourselves.
		noteMutated(stored);
	}

	/**
	 * Whether keystrokes should flow into xterm at all. Mobile spectator
	 * stays read-by-default — the on-screen keyboard popping up on every
	 * tap would clobber the watch-only UX. Everywhere else (shell mode,
	 * desktop spectator) we keep xterm focused so the user can type as
	 * if it were a real terminal.
	 */
	const keyboardEnabled = $derived(!(isSpectator && isMobile));

	function refocusTerminal(): void {
		if (!keyboardEnabled) return;
		try { term?.focus(); } catch { /* ignore */ }
	}

	/**
	 * Click anywhere inside the terminal page → refocus xterm.
	 * The original click target's `onclick` has already run by the time
	 * this bubble-phase handler fires, so button actions complete normally
	 * — we just steal focus back so the next keystroke lands in xterm
	 * instead of a now-focused button.
	 */
	function handlePageClick(): void {
		if (pinnedOrdinal !== null) client?.selectPane(pinnedOrdinal);
		refocusTerminal();
	}

	/**
	 * Capture-phase keyboard shortcuts. Registered at `window` level so
	 * they fire BEFORE xterm's textarea processes the key — without
	 * capture, Ctrl+L would be converted to `^L` and sent to the shell
	 * (clear-screen) before we got a look. The `pageEl.contains(active)`
	 * gate scopes the listener to the focused terminal note: with
	 * multiple terminal note windows open on desktop, each instance
	 * attaches its own listener and only the one containing focus
	 * handles the key.
	 *
	 *   Ctrl+H        → prev-pane    (relative pane cycle)
	 *   Ctrl+L        → next-pane    (relative pane cycle)
	 *   Ctrl+Shift+H  → prev-window  (matches `«` button)
	 *   Ctrl+Shift+L  → next-window  (matches `»` button)
	 *
	 * The footer's pane buttons are absolute (1/2/3/4 → that pane); the
	 * Ctrl+H/L pair stays relative so desktop keeps a quick cycle.
	 *
	 * Spectator-only; in shell mode these would clobber the user's own
	 * Ctrl+H (^H = backspace) and Ctrl+L (^L = clear) keystrokes.
	 */
	function handleWindowKeydown(e: KeyboardEvent): void {
		if (!isSpectator || isMobile || !client || !pageEl) return;
		const active = document.activeElement;
		if (active && active !== document.body && !pageEl.contains(active)) return;

		// 더블탭 분기 — Ctrl/Alt/Shift 단독 키. 두 번째 탭이 윈도우 안이면
		// 토글, 아니면 첫 탭 등록. 단독 modifier keydown 자체는 어차피 셸로
		// 의미 있는 바이트를 보내지 않으므로 항상 여기서 return.
		const modName = modKeyFromEventKey(e.key);
		if (modName) {
			const decision = onStickyModKeydown(
				doubleTapState,
				modName,
				e.repeat,
				performance.now()
			);
			doubleTapState = decision.state;
			if (decision.toggle) {
				toggleStickyMod(decision.toggle);
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}
		// 비-modifier 키는 priming 무효화 (Ctrl+L 같은 chord 이후 단독 Ctrl 탭이
		// "두 번째 탭"으로 오해되지 않도록).
		doubleTapState = onStickyNonModKeydown(doubleTapState);

		// 칩 자체에 키보드 포커스가 있으면 sticky 분기를 건너뛴다 — 그렇지
		// 않으면 Alt-armed + Enter로 칩을 토글하려는 동작이 sticky-Alt+Enter
		// 매칭에 가로채여 \x1b\r 가 셸로 가버리고 칩 토글이 안 된다.
		// pane-nav 단축키는 칩 포커스와 무관하게 그대로 동작해야 하므로
		// 전체 return 이 아니라 sticky 분기만 스킵.
		const focusOnStickyChip =
			active instanceof HTMLElement && !!active.closest('.sticky-mods');

		// sticky 분기 — pane-nav 단축키 검사 이전. armed 상태일 때 대응
		// 키면 변환 바이트 전송 + 모든 mod 해제 + 이벤트 차단. 비대응 키면
		// preventDefault/stopPropagation 없이 return — capture 단계 끝나고
		// target 단계에서 xterm이 정상 처리 (sticky는 유지).
		if (!focusOnStickyChip && (stickyMods.ctrl || stickyMods.alt || stickyMods.shift)) {
			const seq = computeStickyKeySequence(e, stickyMods);
			if (seq !== null) {
				client.send(seq);
				resetStickyMods();
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// 기존 pane-nav 단축키 (변경 없음)
		if (!e.ctrlKey || e.altKey || e.metaKey) return;
		const k = e.key.toLowerCase();
		if (k !== 'h' && k !== 'l') return;
		e.preventDefault();
		e.stopPropagation();
		if (e.shiftKey) {
			tmuxNav(k === 'h' ? 'prev-window' : 'next-window');
		} else {
			// Pin 활성 중에는 pane shift도 footer 1~5처럼 비활성.
			// 이벤트는 이미 preventDefault 했으므로 ^H/^L이 셸로 가지는 않음.
			if (pinnedOrdinal !== null) return;
			tmuxNav(k === 'h' ? 'prev-pane' : 'next-pane');
		}
	}

	/**
	 * Companion to `handleWindowKeydown` — observes bare Ctrl/Alt/Shift
	 * key-up events so the double-tap detector can prime its window. Only
	 * a clean keyup (no other modifier still held + matched against a
	 * pending keydown of the same mod) primes; combos like Ctrl+L don't.
	 */
	function handleWindowKeyup(e: KeyboardEvent): void {
		if (!isSpectator || isMobile) return;
		const modName = modKeyFromEventKey(e.key);
		if (!modName) return;
		doubleTapState = onStickyModKeyup(
			doubleTapState,
			modName,
			{ ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey },
			performance.now()
		);
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
			convertEol: false,
			// 사용자가 스크롤백 위로 올려서 과거 출력을 읽는 중에 타자를 치면
			// xterm 기본값은 viewport 를 강제로 맨 아래로 스냅한다. 관전 모드
			// 데스크탑에서는 이게 "타자 칠 때마다 자동 스크롤 복귀" 로 체감되어
			// 매우 거슬리므로 비활성. 셸 모드도 동일하게 끄는 게 일관적 — 사용자가
			// 명시적으로 ↓ 인디케이터를 누르거나 맨 아래로 드래그하면 복귀한다.
			scrollOnUserInput: false
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

		// 터미널 벨 — shell 모드 + 설정 on일 때만. \x07은 이미 데이터 스트림으로
		// 도착하므로 onBell 연결만으로 충분하다. 설정은 마운트 시점 1회 읽음 —
		// 토글을 바꾸면 노트를 다시 열어야 반영된다(다른 터미널 설정과 동일).
		if (!isSpectator) {
			const bellEnabled = await getTerminalBellEnabled();
			if (bellEnabled) {
				const ringBell = createBellRinger();
				term!.onBell(() => ringBell());
			}
		}

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

		if (isSpectator) {
			term.onScroll(() => {
				recomputeScroll();
				// scrollState.atBottom 가 바뀌면 stage 높이도 바뀌어야 한다
				// (스크롤백 열람 → 전체 높이, 다시 라이브 → 콘텐츠 분량).
				applySpectatorFit();
			});
		}

		// 빈 spectate: 피커 노트 + 미선택 → 초기 WS 연결 보류. 사용자가
		// "세션 선택"으로 세션을 고르면 reconnect() 가 그 세션에 연결한다.
		// term + onScroll 배선은 위에서 이미 무조건 끝냈고, 아래 키보드/리사이즈/
		// 붙여넣기 배선도 무조건 실행한다(전부 client?. 가드라 null client 안전) —
		// 그래야 나중에 reconnect() 로 세션을 골라도 입력/리사이즈가 살아 있다.
		// 여기서는 오직 클라이언트 생성/connect 만 게이트한다.
		if (!awaitingPick) {
		client = new TerminalWsClient({
			bridge,
			target: spec.target,
			token,
			cols: term.cols,
			rows: term.rows,
			spectate: effectiveSession,
			onData: (chunk) => {
				if (term) {
					term.write(chunk, () => {
						if (isSpectator) {
							recomputeScroll();
							// 새 데이터로 cursor / 마지막 비어있지 않은 행이 바뀌었을 수
							// 있으므로 stage 높이도 다시 계산. alt-screen 진입/종료
							// (DECSET 1049) 토글도 여기서 반영된다.
							applySpectatorFit();
						}
					});
				}
			},
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
				// 관전 모드 + pin 활성 → 구독 전환. Bridge handles independent
				// live stream for the pinned pane — no selectPane needed.
				if (isSpectator && s === 'open' && pinnedOrdinal !== null) {
					client?.subscribePane(pinnedOrdinal);
				}
			},
			onPaneSwitch: (info) => {
				// Auto-clear unavailable banner when pane subscription re-resolves.
				pinUnavailableInfo = null;
				applyPaneSwitch(info);
				try { term?.resize(info.cols, info.rows); } catch { /* ignore */ }
				requestAnimationFrame(() => applySpectatorFit());
			},
			onPaneUnavailable: (info) => {
				pinUnavailableInfo = info;
			},
			onPaneResize: ({ cols, rows }) => {
				spectatorCols = cols;
				spectatorRows = rows;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
				requestAnimationFrame(() => applySpectatorFit());
			},
			onImageResult: (ok, info) => {
				imageUploadCount = Math.max(0, imageUploadCount - 1);
				if (ok) pushToast('이미지 전송됨', {});
				else pushToast(info.message ?? '이미지 전송 실패', { kind: 'error' });
			},
		});
		client.connect();
		} // end !awaitingPick gate for client create + connect
		if (awaitingPick) {
			// 미선택 피커 — 끊김 상태로 시작해 "세션 선택" 안내를 띄운다.
			status = 'closed';
			statusMessage = '';
		}

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
			if (pinnedOrdinal !== null) client?.selectPane(pinnedOrdinal);
			client?.send(data);
		});

		// Auto-focus so the user can type immediately without first
		// clicking into the xterm canvas. The click-anywhere refocus
		// handler on `.terminal-page` keeps focus on xterm even after
		// header/footer button clicks. Mobile spectator stays unfocused
		// so the on-screen keyboard doesn't pop on entry.
		refocusTerminal();
		// Capture-phase shortcut listener — must beat xterm's own
		// textarea keydown handler, so we register on `window` with
		// `capture: true`.
		window.addEventListener('keydown', handleWindowKeydown, true);
		window.addEventListener('keyup', handleWindowKeyup, true);
		// 이미지 붙여넣기/드롭 — pageEl에 capture-phase로 등록해 xterm의 자체
		// textarea 핸들러보다 먼저 가로챈다. 셸·관전 양 모드에서 모두 활성화된다.
		if (pageEl) {
			pageEl.addEventListener('paste', handleImagePaste, true);
			pageEl.addEventListener('dragover', handleImageDragOver, true);
			pageEl.addEventListener('drop', handleImageDrop, true);
		}
	});

	onDestroy(() => {
		unmounted = true;
		window.removeEventListener('keydown', handleWindowKeydown, true);
		window.removeEventListener('keyup', handleWindowKeyup, true);
		if (pageEl) {
			pageEl.removeEventListener('paste', handleImagePaste, true);
			pageEl.removeEventListener('dragover', handleImageDragOver, true);
			pageEl.removeEventListener('drop', handleImageDrop, true);
		}
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

	// 세션 피커 — 빈 spectate: 노트에서만 노출. 모달에 브릿지 세션 목록을 띄우고,
	// 행을 고르면 selectedSession 을 세팅해 reconnect() 가 그 세션을 관전한다.
	async function openPicker() {
		if (!resolvedBridge || !resolvedToken) return;
		pickerOpen = true;
		pickerError = '';
		pickerLoading = true;
		// Autofocus the close button after the modal renders.
		queueMicrotask(() => pickerCloseBtn?.focus());
		try {
			pickerSessions = await fetchSessions(resolvedBridge, resolvedToken, {
				user: spec.user,
				host: spec.host,
				port: spec.port
			});
		} catch {
			pickerError = '데스크탑에 연결할 수 없습니다 (꺼져 있거나 네트워크 문제).';
		} finally {
			pickerLoading = false;
		}
	}
	function closePicker() {
		pickerOpen = false;
	}
	function selectSession(name: string) {
		pickerOpen = false;
		selectedSession = name; // effectiveSession 갱신 → reconnect 가 그 세션에 연결
		reconnect();
	}

	function reconnect() {
		if (!resolvedBridge || !resolvedToken) return;
		resetSpectatorState(); // clear stale pane info so buttons reflect the new session
		pinUnavailableInfo = null; // clear unavailable banner on reconnect
		connectFired = false; // allow connect: script to re-run on next 'open'
		// 이전 연결에서 in-flight 였던 이미지 업로드는 image-ok/error를 못 받았으므로
		// 카운터가 stuck 상태일 수 있다 — 재연결 시 리셋해서 "업로드 중…" 버튼을 푼다.
		imageUploadCount = 0;
		resetStickyMods(); // 재연결 시 sticky 상태 잔존 방지
		doubleTapState = INITIAL_DOUBLE_TAP_STATE; // 더블탭 priming 도 같이 초기화
		client?.close();
		term?.reset();
		scrollState = INITIAL_SCROLL_STATE;
		status = 'connecting';
		statusMessage = '';
		client = new TerminalWsClient({
			bridge: resolvedBridge,
			target: spec.target,
			token: resolvedToken,
			cols: term?.cols ?? 80,
			rows: term?.rows ?? 24,
			spectate: effectiveSession,
			onData: (chunk) => {
				if (term) {
					term.write(chunk, () => {
						if (isSpectator) {
							recomputeScroll();
							applySpectatorFit();
						}
					});
				}
			},
			onStatus: (s, info) => {
				status = s;
				if (info?.message) statusMessage = info.message;
				else if (s === 'closed' && info?.code !== undefined) statusMessage = `종료됨 (code ${info.code})`;
				else statusMessage = '';
				if (!isSpectator && s === 'open' && !connectFired) {
					connectFired = true;
					void runConnectScript(spec.connect, (line) => client?.send(line));
				}
				if (isSpectator && s === 'open' && pinnedOrdinal !== null) {
					client?.subscribePane(pinnedOrdinal);
				}
			},
			onPaneSwitch: (info) => {
				// Auto-clear unavailable banner when pane subscription re-resolves.
				pinUnavailableInfo = null;
				applyPaneSwitch(info);
				try { term?.resize(info.cols, info.rows); } catch { /* ignore */ }
			},
			onPaneUnavailable: (info) => {
				pinUnavailableInfo = info;
			},
			onPaneResize: ({ cols, rows }) => {
				spectatorCols = cols;
				spectatorRows = rows;
				try { term?.resize(cols, rows); } catch { /* ignore */ }
			},
			onImageResult: (ok, info) => {
				imageUploadCount = Math.max(0, imageUploadCount - 1);
				if (ok) pushToast('이미지 전송됨', {});
				else pushToast(info.message ?? '이미지 전송 실패', { kind: 'error' });
			},
		});
		client.connect();
		refocusTerminal();
	}
</script>

<!--
	The click handler is a passive focus-redirect that fires on bubble
	AFTER interactive children (buttons inside this container) handle
	their own clicks. It does not introduce a new interaction surface
	on the div — it just steals focus back to xterm so subsequent
	keystrokes land in the terminal instead of a now-focused button.
-->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="terminal-page"
	class:panel-open={panelOpen}
	class:mobile={isMobile}
	class:spectator={isSpectator}
	bind:this={pageEl}
	onclick={handlePageClick}
>
	<div class="terminal-header">
		<div class="meta">
			<div class="line"><span class="label">target</span><code>{spec.target}</code></div>
			{#if isSpectator}
				<div class="line">
					<span class="label">관전</span>
					<code>tmux {effectiveSession ?? '— 세션 미선택'}{spectatorPaneId ? ` · ${spectatorPaneId}` : ''}{spectatorCols ? ` · ${spectatorCols}×${spectatorRows}` : ''}</code>
					{#if spec.spectatePicker && selectedSession}
						<button type="button" class="picker-change" onclick={openPicker}>세션 변경</button>
					{/if}
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
			<button
				type="button"
				class="toggle"
				onclick={openImagePicker}
				disabled={status !== 'open' || imageUploadCount > 0}
			>
				{imageUploadCount > 0 ? '업로드 중…' : '이미지'}
			</button>
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

	{#if pinUnavailableInfo}
		<div class="banner banner-pin-unavailable">
			패널 {pinUnavailableInfo.pinnedOrdinal}번 없음 (현재 윈도우 패널 {pinUnavailableInfo.paneCount}개)
		</div>
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
			  .xterm-host  — flex container; in spectator, overflow is hidden
			                 (NOT a scroll surface). xterm's own .xterm-viewport
			                 (inside .xterm-mount) provides vertical scrollback.
			  .xterm-stage — explicit scaled-pixel dimensions in spectator
			                 so .xterm-host's layout box reflects the visual
			                 footprint of the transformed mount.
			  .xterm-mount — natural cell-based dimensions; xterm.js mounts
			                 here. In spectator, gets transform:scale(s).
			Non-spectator: stage + mount stay 100%×100% (transparent).
		-->
		<div
			class="xterm-host"
			bind:this={xtermHostEl}
			ontouchstart={onSpectatorTouchStart}
			ontouchmove={onSpectatorTouchMove}
			ontouchend={onSpectatorTouchEnd}
			ontouchcancel={onSpectatorTouchEnd}
		>
			<div class="xterm-stage" bind:this={xtermStageEl}>
				<div class="xterm-mount" bind:this={xtermContainer}></div>
			</div>
		</div>
		{#if awaitingPick}
			<div class="picker-empty">
				<p>관전할 tmux 세션을 선택하세요.</p>
				<button type="button" class="picker-pick" onclick={openPicker}>세션 선택</button>
			</div>
		{/if}
		{#if isSpectator && !scrollState.atBottom}
			<button
				type="button"
				class="scroll-bottom-indicator"
				onclick={() => { term?.scrollToBottom(); }}
			>
				{scrollState.newLines > 0 ? `↓ 새 출력 ${scrollState.newLines}줄` : '↓ 맨 아래로'}
			</button>
		{/if}
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
			<div class="spec-windowbar">
				<div class="win-label" aria-live="polite">
					{#if spectatorWindowIndex || spectatorWindowName}
						<span class="win-idx">{spectatorWindowIndex}</span>
						<span class="win-name">{spectatorWindowName || '(이름 없음)'}</span>
					{:else}
						<span class="win-placeholder">윈도우 정보 대기 중…</span>
					{/if}
				</div>
				<div class="sticky-mods" role="group" aria-label="고정 modifier 키">
					<button
						type="button"
						class="sticky-chip"
						class:armed={stickyMods.ctrl}
						aria-pressed={stickyMods.ctrl}
						aria-label="Ctrl 키 고정 (Ctrl 두 번 눌러 토글)"
						title="다음 키에 Ctrl 적용 — Ctrl 두 번 눌러도 토글"
						onclick={() => toggleStickyMod('ctrl')}
						disabled={status !== 'open'}
					>Ctrl</button>
					<button
						type="button"
						class="sticky-chip"
						class:armed={stickyMods.alt}
						aria-pressed={stickyMods.alt}
						aria-label="Alt 키 고정 (Alt 두 번 눌러 토글)"
						title="다음 키에 Alt 적용 — Alt 두 번 눌러도 토글"
						onclick={() => toggleStickyMod('alt')}
						disabled={status !== 'open'}
					>Alt</button>
					<button
						type="button"
						class="sticky-chip"
						class:armed={stickyMods.shift}
						aria-pressed={stickyMods.shift}
						aria-label="Shift 키 고정 (Shift 두 번 눌러 토글)"
						title="다음 키에 Shift 적용 — Shift 두 번 눌러도 토글"
						onclick={() => toggleStickyMod('shift')}
						disabled={status !== 'open'}
					>Shift</button>
				</div>
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
					{#each [1, 2, 3, 4, 5] as n (n)}
						<button
							type="button"
							class="icon pane-num"
							class:active={n === spectatorPaneOrdinal && pinnedOrdinal === null}
							class:pinned={n === pinnedOrdinal}
							class:unavailable={n === pinnedOrdinal && pinUnavailableInfo !== null}
							title={n === pinnedOrdinal
								? `패널 ${n} 고정 (해제하려면 다시 누르세요)`
								: `패널 ${n}`}
							onclick={() => onPaneNumClick(n)}
							disabled={status !== 'open'
								|| (n !== pinnedOrdinal && spectatorPaneCount > 0 && n > spectatorPaneCount)
								|| (pinnedOrdinal !== null && n !== pinnedOrdinal)}
						>{#if n === pinnedOrdinal}🔒{/if}{n}</button>
					{/each}
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

<input
	type="file"
	accept="image/*"
	multiple
	bind:this={imageFileInput}
	onchange={onImageFilePicked}
	style="display: none"
/>

{#if pickerOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="picker-overlay"
		role="presentation"
		onclick={closePicker}
		onkeydown={(e) => { if (e.key === 'Escape') closePicker(); }}
	>
		<div
			class="picker-panel"
			role="dialog"
			aria-modal="true"
			aria-label="tmux 세션 선택"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<div class="picker-head">
				<span>tmux 세션</span>
				<button type="button" bind:this={pickerCloseBtn} onclick={closePicker} aria-label="닫기">✕</button>
			</div>
			{#if pickerLoading}
				<div class="picker-msg">불러오는 중…</div>
			{:else if pickerError}
				<div class="picker-msg error">{pickerError}</div>
				<button type="button" class="picker-retry" onclick={openPicker}>다시 시도</button>
			{:else if pickerSessions.length === 0}
				<div class="picker-msg">실행 중인 tmux 세션이 없습니다.</div>
			{:else}
				<ul class="picker-list">
					{#each pickerSessions as s (s.name)}
						<li>
							<button type="button" onclick={() => selectSession(s.name)}>
								<span class="ps-name">{s.name}</span>
								<span class="ps-meta">{s.windows}창 · {s.attached ? '●붙음' : '○'}{s.command ? ` · ${s.command}` : ''}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

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
			{#if stickyMods.ctrl || stickyMods.alt || stickyMods.shift}
				<div class="send-sticky-badge" role="status">
					{#if stickyMods.ctrl}<span class="badge-tag">Ctrl+</span>{/if}
					{#if stickyMods.alt}<span class="badge-tag">Alt+</span>{/if}
					{#if stickyMods.shift}<span class="badge-tag">Shift+</span>{/if}
					<span class="badge-desc">다음 키에 적용됩니다</span>
				</div>
			{/if}
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
				onpaste={onSendPopupPaste}
			/>
			<div class="send-quick">
				<span class="send-quick-label">빠른 키</span>
				<button type="button" onclick={() => sendQuickKey('y\r')}>y ↵</button>
				<button type="button" onclick={() => sendQuickKey('n\r')}>n ↵</button>
				<button type="button" onclick={() => sendQuickKey('1\r')}>1 ↵</button>
				<button type="button" onclick={() => sendQuickKey('\r')}>↵</button>
				<button type="button" onclick={() => sendQuickKey('\x1b')}>Esc</button>
				<button type="button" onclick={() => sendQuickKey('\x03')}>^C</button>
				<button type="button" title="Tab (자동완성)" onclick={() => sendQuickKey('\t')}>Tab</button>
				<button type="button" title="Backspace" onclick={() => sendQuickKey('\x7f')}>⌫</button>
				<button type="button" title="Page Up (TUI 내부 스크롤)" onclick={() => sendQuickKey('\x1b[5~')}>PgUp</button>
				<button type="button" title="Page Down (TUI 내부 스크롤)" onclick={() => sendQuickKey('\x1b[6~')}>PgDn</button>
				<button type="button" title="왼쪽 화살표" onclick={() => sendQuickKey('\x1b[D')}>←</button>
				<button type="button" title="아래 화살표" onclick={() => sendQuickKey('\x1b[B')}>↓</button>
				<button type="button" title="위 화살표" onclick={() => sendQuickKey('\x1b[A')}>↑</button>
				<button type="button" title="오른쪽 화살표" onclick={() => sendQuickKey('\x1b[C')}>→</button>
			</div>
			<div class="send-image-row">
				<button
					type="button"
					onclick={onClickPasteImage}
					disabled={imageUploadCount > 0 || status !== 'open'}
				>
					{imageUploadCount > 0 ? '업로드 중…' : '📋 이미지 붙여넣기'}
				</button>
				<button
					type="button"
					onclick={openImagePicker}
					disabled={imageUploadCount > 0 || status !== 'open'}
				>
					📷 이미지 불러오기
				</button>
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
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		flex-wrap: wrap;
		font-size: 0.75rem;
		line-height: 1.2;
		color: #aac;
		min-height: 1em;
		min-width: 0;
	}
	.spec-windowbar .win-label {
		display: flex;
		align-items: baseline;
		gap: 6px;
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
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
	.sticky-mods {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		flex-shrink: 0;
	}
	.spec-windowbar .sticky-chip {
		font-size: 0.7rem;
		padding: 2px 8px;
		border: 1px solid #557;
		background: transparent;
		color: #aac;
		border-radius: 999px;
		cursor: pointer;
		line-height: 1.2;
		min-height: 1.4em;
		font-family: ui-monospace, Menlo, Consolas, monospace;
	}
	.spec-windowbar .sticky-chip:hover:not(:disabled) {
		border-color: #779;
		color: #ccd;
	}
	.spec-windowbar .sticky-chip:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.spec-windowbar .sticky-chip.armed {
		background: #6cf;
		color: #1e1e1e;
		border-color: #6cf;
		font-weight: 600;
	}
	.spec-windowbar .sticky-chip:focus-visible {
		outline: 2px solid #6cf;
		outline-offset: 1px;
	}
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
	.spec-footer button.pane-num {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-weight: 600;
	}
	/* Active pane: filled accent. Distinct from idle (#3a3a3a) and the
	   disabled state (opacity 0.5 via `.spec-footer button:disabled`). */
	.spec-footer button.pane-num.active {
		background: #2563eb;
		border-color: #5b8def;
		color: #fff;
	}
	.spec-footer button.pane-num.pinned {
		background: #2563eb;
		border-color: #5b8def;
		color: #fff;
	}
	.spec-footer button.pane-num.pinned.unavailable {
		border-color: #f0c000;
		box-shadow: inset 0 0 0 1px #f0c000;
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
	.banner-pin-unavailable {
		background: #fff8e1;
		color: #6b5b00;
		border-left: 3px solid #f0c000;
		padding: 6px 10px;
		font-size: 0.85em;
	}
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
		position: relative;
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

	/* Spectator: width-fit. Both axes hidden on the outer host so it
	   does NOT become a competing scroll container — xterm's own
	   .xterm-viewport (inside .xterm-mount) is the sole vertical scroll
	   surface. Removing overflow-y:auto lets touch events propagate
	   through the outer layers and reach the native xterm scrollback
	   scroller. Horizontal is always hidden — width fit guarantees no
	   horizontal overflow. */
	.terminal-page.spectator .xterm-host {
		/* Bottom-anchor the stage to the host's bottom edge. In shell mode
		   the stage is sized to the meaningful content rows
		   (computeStageHeight → n × cellH × scale), so flex-end anchors
		   the cursor row to the host bottom and the empty terminal-page
		   background fills above. In alt-screen / scrolled-up mode the
		   stage is full naturalH × scale; if it exceeds host height the
		   TOP overflows and is clipped (standard "tall pane scrolled
		   into the visible area" behavior). */
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		overflow-x: hidden;
		overflow-y: hidden;
	}
	/* Mobile spectator: own the vertical drag. `touch-action: none` disables
	   the browser's native pan/zoom so our touch→scrollLines handler is the
	   sole scroll path — xterm v6's own touch gesture is desynced by the
	   transform:scale and cannot be relied on here. */
	.terminal-page.spectator.mobile .xterm-host {
		touch-action: none;
	}
	.terminal-page.spectator .xterm-stage {
		/* width / height set inline by applySpectatorFit. */
		position: relative;
		/* Keep the explicit scaled height — never let the flex parent
		   shrink the stage. A taller-than-host pane must overflow the TOP
		   (clipped), not compress; compression would desync the absolute
		   .xterm-mount. */
		flex-shrink: 0;
		/* Stage 가 셸 모드에서 콘텐츠 분량(n × cellH × scale) 으로 축소되었을 때
		   mount 의 자연 높이(R × cellH × scale) 가 stage 밖으로 (= 아래로)
		   넘치는 부분을 잘라낸다. mount 의 0..n-1 행만 보이고 n..R-1 의 빈
		   셀들은 stage 박스 바깥이 되어 paint 도 hit-test 도 안 된다. */
		overflow: hidden;
	}
	.terminal-page.spectator .xterm-mount {
		/* width / height / transform set inline by applySpectatorFit. */
		position: absolute;
		top: 0;
		left: 0;
	}

	.scroll-bottom-indicator {
		position: absolute;
		left: 50%;
		bottom: 12px;
		transform: translateX(-50%);
		z-index: 20;
		background: #1e6f3f;
		color: #fff;
		border: 1px solid #2b8;
		border-radius: 14px;
		padding: 5px 14px;
		font-size: 0.78rem;
		cursor: pointer;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
	}
	.scroll-bottom-indicator:active {
		background: #28814c;
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
		z-index: var(--z-modal);
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
	.send-sticky-badge {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
		font-size: 0.85rem;
		padding: 6px 10px;
		background: rgba(102, 204, 255, 0.12);
		border: 1px solid rgba(102, 204, 255, 0.35);
		border-radius: 6px;
		color: #cde;
	}
	.send-sticky-badge .badge-tag {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-weight: 600;
		color: #6cf;
	}
	.send-sticky-badge .badge-desc {
		opacity: 0.85;
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
	.send-image-row {
		display: flex;
		gap: clamp(0.25rem, 1.5vw, 0.5rem);
		margin-top: clamp(0.25rem, 1.5vw, 0.5rem);
	}
	.send-image-row button {
		flex: 1;
		padding: clamp(0.4rem, 2vw, 0.6rem);
		font-size: clamp(0.75rem, 3vw, 0.85rem);
		background: #3a3a3a;
		color: #ddd;
		border: 1px solid #555;
		border-radius: 4px;
		cursor: pointer;
	}
	.send-image-row button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
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

	/* 세션 피커(런처) — 빈 spectate: 노트 */
	.picker-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		background: #1e1e1e;
		color: #ddd;
		z-index: 5;
	}
	.picker-pick,
	.picker-change,
	.picker-retry {
		background: #2d6cdf;
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 8px 16px;
		cursor: pointer;
		font-size: 14px;
	}
	.picker-change {
		padding: 2px 8px;
		font-size: 12px;
		margin-left: 8px;
	}
	.picker-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal);
	}
	.picker-panel {
		background: #252526;
		color: #ddd;
		border-radius: 8px;
		min-width: min(420px, 92vw);
		max-height: 70vh;
		overflow: auto;
		padding: 12px;
	}
	.picker-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
		font-weight: 600;
	}
	.picker-head button {
		background: none;
		border: none;
		color: #aaa;
		cursor: pointer;
		font-size: 16px;
	}
	.picker-msg {
		padding: 16px;
		text-align: center;
		color: #bbb;
	}
	.picker-msg.error {
		color: #f48771;
	}
	.picker-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.picker-list li button {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 2px;
		text-align: left;
		background: #2d2d30;
		border: 1px solid #3a3a3c;
		border-radius: 6px;
		padding: 8px 10px;
		margin-bottom: 6px;
		color: #eee;
		cursor: pointer;
	}
	.picker-list li button:hover {
		background: #37373a;
	}
	.ps-name {
		font-family: monospace;
		font-size: 14px;
	}
	.ps-meta {
		font-size: 12px;
		color: #9aa;
	}
</style>
