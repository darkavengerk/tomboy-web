/**
 * Spectator helpers: pure functions and shared interfaces used by
 * SpectatorHub and SpectatorSubscription (see spectatorHub.ts).
 *
 * The SpectatorSession class has been removed. The hub/subscription model
 * (SpectatorHub + SpectatorSubscription) in spectatorHub.ts replaces it,
 * sharing a single ssh + tmux -CC client per (target, session) pair and
 * fan-outing %output to per-WS subscriptions.
 */

import { controlMasterArgs } from './pty.js';
import type { SshTarget } from './pty.js';

/**
 * Default virtual PTY size the spectator claims (cols × rows) so it never
 * becomes the smallest client under `window-size smallest` — the real desktop
 * client wins. When ONLY a spectator is attached (desktop off/detached), the
 * window resizes to exactly this, so it doubles as the "phone-alone" tmux
 * window size. 318 = a 3-vertical-pane desktop window (≈106 cols/pane); the
 * phone renders one active pane, so it sees ≈106 even though the window is 318.
 * Both call sites (stty pre-attach claim + refresh-client belt-and-suspenders
 * in spectatorHub.ts) go through `spectatorVirtualSize` — keep them in sync.
 */
export const SPECTATOR_VIRTUAL_COLS = 318;
export const SPECTATOR_VIRTUAL_ROWS = 65;

/**
 * Some sessions are inherently single-pane (never split) — e.g. claude-squad,
 * which manages many agents but keeps each in a single-pane window. Claiming
 * the full multi-pane width (318) there makes the phone render a 318-wide
 * single pane = far too big. Claim the single-pane width instead so the phone
 * shows ≈106 cols. Safe to shrink the window for these: there are no sibling
 * panes to squish. Matched by session-name prefix.
 */
export const SPECTATOR_SINGLE_PANE_COLS = 106;
export const SINGLE_PANE_SESSION_PREFIXES = ['claudesquad'];

/** Per-session virtual PTY size — single-pane sessions get the narrow claim. */
export function spectatorVirtualSize(session: string): { cols: number; rows: number } {
	const singlePane = SINGLE_PANE_SESSION_PREFIXES.some((p) => session.startsWith(p));
	return {
		cols: singlePane ? SPECTATOR_SINGLE_PANE_COLS : SPECTATOR_VIRTUAL_COLS,
		rows: SPECTATOR_VIRTUAL_ROWS
	};
}

export interface SpectatorCallbacks {
	paneSwitch(info: {
		paneId: string;
		cols: number;
		rows: number;
		altScreen: boolean;
		windowIndex: string;
		windowName: string;
		/** Active pane's 1-based footer-button ordinal; 0 = unknown. */
		paneOrdinal: number;
		/** Total panes in the spectated window; 0 = unknown. */
		paneCount: number;
	}): void;
	/** UTF-8 text to write into the client's xterm. */
	data(text: string): void;
	paneResize(info: { cols: number; rows: number }): void;
	/** Pinned ordinal exceeds the current window's pane count. */
	paneUnavailable(info: { pinnedOrdinal: number; paneCount: number }): void;
	error(message: string): void;
	exit(reason?: string): void;
}

const SAFE_SESSION_RE = /^[A-Za-z0-9_\-./@:]+$/;

export type SpectatorNavAction = 'next-pane' | 'prev-pane' | 'next-window' | 'prev-window';

/**
 * Spectator용 ssh argv를 순수 함수로 구성한다. 단위 테스트 가능.
 * `controlPath` 주어지면 ControlMaster 마스터 모드 (셸 모드 PTY ssh와 동일 패턴) —
 * 같은 ControlPath를 가리키는 후속 ssh(imageTransfer.ts)가 이 인증된 연결을 재사용.
 *
 * 인자 순서: `-tt` → 포트 옵션 → StrictHostKeyChecking → (선택적 ControlMaster 옵션)
 * → 호스트 → 인라인 셸 명령. 호스트는 인라인 명령 직전이어야 — OpenSSH는 호스트
 * 뒤의 토큰을 원격 명령으로 취급한다.
 */
export function buildSpectatorSshArgs(
	target: SshTarget,
	session: string,
	controlPath?: string
): string[] {
	if (!SAFE_SESSION_RE.test(session)) {
		throw new Error(`unsafe session name: ${session}`);
	}
	const args: string[] = ['-tt'];
	if (target.port) args.push('-p', String(target.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new');
	if (controlPath) args.push(...controlMasterArgs(controlPath));
	args.push(target.user ? `${target.user}@${target.host}` : target.host);
	const { cols, rows } = spectatorVirtualSize(session);
	args.push(
		`stty cols ${cols} rows ${rows} 2>/dev/null; stty raw -echo; exec tmux -CC attach -t ${session}`
	);
	return args;
}

/**
 * Active pane's 1-based position among the window's panes, plus the total
 * count. Position is the index in `list-panes -F '#{pane_id}'` order — the
 * same ordering SpectatorHub.selectPane() resolves footer-button numbers
 * against, so a highlighted button always matches the button that would
 * re-select it. Ordinal is 0 when the active pane id is not in the list.
 */
export function panePosition(
	paneIds: string[],
	activePaneId: string
): { ordinal: number; count: number } {
	return { ordinal: paneIds.indexOf(activePaneId) + 1, count: paneIds.length };
}
