/**
 * SpectatorHub: shared ssh + tmux -CC client per (target, session). Multiple
 * SpectatorSubscriptions (one per WS) can attach to the same hub and each
 * subscribe to a different pane independently. tmux -CC already streams
 * %output for all panes in the session — this hub fans those out to
 * matching subscriptions instead of dropping non-active pane bytes.
 *
 * Lifecycle:
 *   SpectatorHubRegistry.subscribe(target, session, callbacks)
 *     → first call: spawn ssh, create hub, register in Map, return subscription
 *     → subsequent calls with same hubKey: reuse existing hub
 *   subscription.close()
 *     → refcount--; when 0: hub.destroy() → ssh.kill + tmux.close + socket unlink
 *   ssh.on('exit')
 *     → all subscriptions get callbacks.exit(reason), hub destroyed
 *
 * State caching, output fan-out, and pin/unpin are added in Tasks 2–4.
 * This file (Task 1) only covers the skeleton + registry + lifecycle.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TmuxControlClient } from './tmuxControlClient.js';
import { buildSpectatorSshArgs, type SpectatorCallbacks } from './spectatorSession.js';
import type { SshTarget } from './pty.js';

// ---------------------------------------------------------------------------
// hubKey — pure helper
// ---------------------------------------------------------------------------

/**
 * Canonical registry key for a (target, session) pair.
 * Format: `"<user>@<host>:<port>|<sessionName>"`
 * User may be empty string (e.g. ssh://localhost), port defaults to 22.
 */
export function hubKey(target: SshTarget, session: string): string {
	return `${target.user ?? ''}@${target.host}:${target.port ?? 22}|${session}`;
}

// ---------------------------------------------------------------------------
// Dependency-injection interfaces (enables unit testing without real ssh)
// ---------------------------------------------------------------------------

type SshLike = {
	kill(): void;
	on(event: 'exit', cb: (code: number | null, signal: string | null) => void): SshLike;
	stderr: { on(event: 'data', cb: (buf: Buffer) => void): void };
};

type TmuxLike = {
	close(): void;
	// TmuxLike.on stays loose (...args: any[]) until Task 2 registers concrete event signatures.
	on(event: string, cb: (...args: any[]) => void): void;
	command(cmd: string): Promise<string[]>;
};

export interface SpectatorHubDeps {
	ssh: SshLike;
	tmux: TmuxLike;
	hubKey: string;
	sessionName: string;
	controlPath?: string;
	onDestroy: () => void;
}

// ---------------------------------------------------------------------------
// SpectatorHub
// ---------------------------------------------------------------------------

export class SpectatorHub {
	readonly hubKey: string;
	readonly sessionName: string;
	readonly controlPath?: string;

	private ssh: SshLike;
	private tmux: TmuxLike;
	private onDestroy: () => void;
	private subscriptions: Set<SpectatorSubscription> = new Set();
	private destroyed = false;
	private stderrTail = '';

	constructor(deps: SpectatorHubDeps) {
		this.ssh = deps.ssh;
		this.tmux = deps.tmux;
		this.hubKey = deps.hubKey;
		this.sessionName = deps.sessionName;
		this.controlPath = deps.controlPath;
		this.onDestroy = deps.onDestroy;

		// Accumulate stderr for inclusion in exit reason
		this.ssh.stderr.on('data', (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-1024);
		});

		this.ssh.on('exit', (code, signal) => this.handleSshExit(code, signal));
	}

	addSubscription(sub: SpectatorSubscription): void {
		this.subscriptions.add(sub);
	}

	removeSubscription(sub: SpectatorSubscription): void {
		this.subscriptions.delete(sub);
		if (this.subscriptions.size === 0 && !this.destroyed) {
			this.destroy();
		}
	}

	private handleSshExit(code: number | null, signal: string | null): void {
		if (this.destroyed) return;
		const tail = this.stderrTail.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
		let reason: string;
		if (signal) reason = `ssh signal=${signal}`;
		else if (code !== 0 && code !== null) reason = `ssh exit code=${code}`;
		else reason = 'ssh exit';
		if (tail) reason += `: ${tail.slice(0, 240)}`;
		// Fan-out exit to all subscriptions before destroying
		for (const sub of this.subscriptions) {
			try { sub.callbacks.exit(reason); } catch { /* swallow per-sub errors */ }
		}
		this.destroy();
	}

	private destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		try { this.tmux.close(); } catch { /* ignore */ }
		try { this.ssh.kill(); } catch { /* ignore */ }
		if (this.controlPath) {
			unlink(this.controlPath).catch(() => { /* ignore */ });
		}
		this.onDestroy();
	}
}

// ---------------------------------------------------------------------------
// SpectatorSubscription — per-WS handle (skeleton; filled in T3/T4)
// ---------------------------------------------------------------------------

export class SpectatorSubscription {
	readonly callbacks: SpectatorCallbacks;
	private hub: SpectatorHub;
	private closed = false;

	constructor(hub: SpectatorHub, callbacks: SpectatorCallbacks) {
		this.hub = hub;
		this.callbacks = callbacks;
		hub.addSubscription(this);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.hub.removeSubscription(this);
	}
}

// ---------------------------------------------------------------------------
// HubRegistry — module-level singleton Map<hubKey, SpectatorHub>
// ---------------------------------------------------------------------------

export class HubRegistry {
	private hubs: Map<string, SpectatorHub> = new Map();

	subscribe(
		target: SshTarget,
		session: string,
		callbacks: SpectatorCallbacks,
		opts: { ctrlDir?: string; spawnFn?: typeof spawn } = {}
	): SpectatorSubscription {
		const key = hubKey(target, session);
		let hub = this.hubs.get(key);
		if (!hub) {
			const spawnFn = opts.spawnFn ?? spawn;
			const controlPath = opts.ctrlDir
				? `${opts.ctrlDir}/${randomUUID().slice(0, 8)}.sock`
				: undefined;
			const args = buildSpectatorSshArgs(target, session, controlPath);
			const ssh = spawnFn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess;
			if (!ssh.stdin || !ssh.stdout || !ssh.stderr) {
				throw new Error('ssh stdio not available');
			}
			const tmux = new TmuxControlClient(ssh.stdin);
			(ssh.stdout as NodeJS.ReadableStream).on('data', (chunk: Buffer) => tmux.feed(chunk));
			hub = new SpectatorHub({
				ssh: ssh as unknown as SshLike,
				tmux: tmux as unknown as TmuxLike,
				hubKey: key,
				sessionName: session,
				controlPath,
				onDestroy: () => this.hubs.delete(key)
			});
			this.hubs.set(key, hub);
		}
		return new SpectatorSubscription(hub, callbacks);
	}

	/** Test helper — inject a pre-constructed hub and return a bare subscription. */
	_injectHub(hub: SpectatorHub, callbacks: SpectatorCallbacks): SpectatorSubscription {
		if (!this.hubs.has(hub.hubKey)) {
			this.hubs.set(hub.hubKey, hub);
		}
		return new SpectatorSubscription(hub, callbacks);
	}

	get(key: string): SpectatorHub | undefined {
		return this.hubs.get(key);
	}

	size(): number {
		return this.hubs.size;
	}
}

/** Module-level singleton — shared across the bridge process lifetime. */
export const SpectatorHubRegistry = new HubRegistry();
