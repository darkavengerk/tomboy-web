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
	args.push(
		`stty cols 500 rows 200 2>/dev/null; stty raw -echo; exec tmux -CC attach -t ${session}`
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
