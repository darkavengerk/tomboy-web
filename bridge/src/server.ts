import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
	extractBearer,
	mintToken,
	passwordMatches,
	verifyToken
} from './auth.js';
import { parseSshTarget, spawnForTarget, isLocalTarget, type SshTarget } from './pty.js';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadHostsFile, lookupWolTarget, type WolEntry } from './hosts.js';
import { probePort, sendMagicPacket, waitForPort } from './wol.js';
import { handleLlmChat } from './llm.js';
import { handleRagSearch } from './rag.js';
import { handleOcrProxy } from './ocr.js';
import { handleClaudeChat } from './claude.js';
import { handleGpuStatus, handleGpuUnload } from './gpu.js';
import { handleRemarkableWallpaper } from './remarkable.js';
import { loadRemarkableHosts } from './remarkableHosts.js';
import { SpectatorHubRegistry, type SpectatorSubscription } from './spectatorHub.js';
import { transferImage, bracketedPaste } from './imageTransfer.js';

const PORT = Number(process.env.BRIDGE_PORT || 3000);
const PASSWORD = requireEnv('BRIDGE_PASSWORD');
const SECRET = requireEnv('BRIDGE_SECRET');
const ALLOWED_ORIGIN = requireEnv('BRIDGE_ALLOWED_ORIGIN');
const OCR_SERVICE_URL = requireEnv('OCR_SERVICE_URL');
// CLAUDE_SERVICE_URL is optional — bridge boots without it and returns 503.
const CLAUDE_SERVICE_URL = process.env.CLAUDE_SERVICE_URL ?? '';
// Ollama runs on the desktop alongside ocr-service. The bridge reads this
// from env so deployments without an Ollama on `localhost:11434` (i.e.
// remote-LAN Ollama) can override it. `llm.ts` reads the same env var
// independently — keep them in sync.
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const HOSTS_FILE = process.env.BRIDGE_HOSTS_FILE;
const REMARKABLE_HOSTS_FILE = process.env.BRIDGE_REMARKABLE_HOSTS_FILE;

loadHostsFile(HOSTS_FILE);
loadRemarkableHosts(REMARKABLE_HOSTS_FILE);

// ControlMaster 소켓이 사는 디렉터리. Unix 소켓 경로 길이 제한 때문에 /tmp 아래.
const CTRL_DIR = '/tmp/tomboy-ctl';
mkdirSync(CTRL_DIR, { recursive: true });

// Auth grace window after WebSocket open. The first client message MUST be
// a `connect` frame with a valid token; otherwise the connection is closed.
const AUTH_TIMEOUT_MS = 5000;

const server = createServer(handleHttp);
// maxPayload: 이미지 프레임 수용(10 MB 이미지의 base64 ≈ 13.3 MB). 일반 data
// 프레임은 작으므로 영향 없음.
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
	if (req.url !== '/ws') {
		socket.destroy();
		return;
	}
	if (!originAllowed(req.headers.origin)) {
		socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
		socket.destroy();
		return;
	}
	// Authentication for the WS path is deferred to the first client
	// message: browser WebSocket API has no way to set custom headers on
	// the upgrade, so we cannot read a Bearer token here. The connection
	// is held open for AUTH_TIMEOUT_MS waiting for `connect`.
	wss.handleUpgrade(req, socket, head, (ws) => handleWs(ws));
});

server.listen(PORT, () => {
	console.log(`[term-bridge] listening on :${PORT}, origin=${ALLOWED_ORIGIN}`);
});

// --- HTTP ---

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
	applyCors(req, res);
	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.end();
		return;
	}

	const url = req.url || '/';

	if (url === '/health' && req.method === 'GET') {
		const token = extractBearer(req.headers.authorization);
		const ok = verifyToken(SECRET, token);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ authed: ok }));
		return;
	}

	if (url === '/login' && req.method === 'POST') {
		const body = await readJson(req).catch(() => null);
		if (!body || typeof body.password !== 'string') {
			res.writeHead(400).end();
			return;
		}
		if (!passwordMatches(body.password, PASSWORD)) {
			// Small fixed delay to slow down online guesses; real fail2ban
			// belongs at the proxy layer.
			await sleep(750);
			res.writeHead(401).end();
			return;
		}
		const token = mintToken(SECRET);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ token }));
		return;
	}

	if (url === '/llm/chat' && req.method === 'POST') {
		await handleLlmChat(req, res, SECRET);
		return;
	}

	if (url === '/rag/search' && req.method === 'POST') {
		await handleRagSearch(req, res, SECRET);
		return;
	}

	if (url === '/ocr' && req.method === 'POST') {
		await handleOcrProxy(req, res, SECRET, OCR_SERVICE_URL);
		return;
	}

	if (url === '/claude/chat' && req.method === 'POST') {
		await handleClaudeChat(req, res, SECRET, CLAUDE_SERVICE_URL);
		return;
	}

	if (url === '/gpu/status' && req.method === 'GET') {
		await handleGpuStatus(req, res, SECRET, OCR_SERVICE_URL, OLLAMA_URL);
		return;
	}

	if (url === '/gpu/unload' && req.method === 'POST') {
		await handleGpuUnload(req, res, SECRET, OCR_SERVICE_URL, OLLAMA_URL);
		return;
	}

	if (url === '/remarkable/wallpaper' && req.method === 'POST') {
		await handleRemarkableWallpaper(req, res, SECRET);
		return;
	}

	res.writeHead(404).end();
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
	const origin = req.headers.origin;
	if (origin && originAllowed(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
		res.setHeader('Vary', 'Origin');
		// No `Allow-Credentials` — we no longer use cookies. The Bearer
		// token travels in the Authorization header (HTTP) or in the first
		// WS message, both of which are explicit per-request.
	}
}

function originAllowed(origin: string | undefined): boolean {
	if (!origin) return false;
	return ALLOWED_ORIGIN.split(',').some((o) => o.trim() === origin);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > 4096) throw new Error('body too large');
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw) return {};
	return JSON.parse(raw);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// --- WebSocket session ---

interface ClientMsg {
	type: 'connect' | 'data' | 'resize' | 'tmux-nav' | 'image' | 'subscribe-pane';
	target?: string;
	token?: string;
	cols?: number;
	rows?: number;
	d?: string;
	mode?: 'shell' | 'spectate';
	session?: string;
	action?: 'next-pane' | 'prev-pane' | 'next-window' | 'prev-window' | 'select-pane';
	index?: number;
	ordinal?: number;
	mime?: string;
	data?: string;
}

const TMUX_NAV_ACTIONS = new Set([
	'next-pane',
	'prev-pane',
	'next-window',
	'prev-window'
]);

function handleWs(ws: WebSocket): void {
	let pty: ReturnType<typeof spawnForTarget> | null = null;
	let subscription: SpectatorSubscription | null = null;
	let connected = false;
	let controlPath: string | null = null;
	let sessionTarget: SshTarget | null = null;
	const abortCtrl = new AbortController();
	const authTimer = setTimeout(() => {
		if (!connected) {
			try { ws.close(1008, 'auth timeout'); } catch { /* ignore */ }
		}
	}, AUTH_TIMEOUT_MS);

	const send = (obj: unknown): void => {
		if (ws.readyState !== ws.OPEN) return;
		ws.send(JSON.stringify(obj));
	};

	ws.on('message', (raw) => {
		const rawBuf = raw as Buffer;
		let msg: ClientMsg;
		try {
			msg = JSON.parse(rawBuf.toString());
		} catch {
			// 깨진 JSON은 라우팅의 흔한 실수 신호 — 1줄 남김.
			console.log(`[ws] bad JSON, ${rawBuf.length} bytes`);
			return;
		}

		if (msg.type === 'connect') {
			if (connected) return;
			if (!verifyToken(SECRET, msg.token)) {
				send({ type: 'error', message: 'unauthorized' });
				ws.close(1008, 'unauthorized');
				return;
			}
			const target = parseSshTarget(String(msg.target ?? ''));
			if (!target) {
				send({ type: 'error', message: 'invalid target' });
				ws.close(1008, 'invalid target');
				return;
			}
			// Mark connected early so duplicate `connect` frames during WOL
			// wait can't re-enter this branch.
			connected = true;
			clearTimeout(authTimer);

			if (msg.mode === 'spectate') {
				const session = typeof msg.session === 'string' ? msg.session : '';
				if (!session) {
					send({ type: 'error', message: 'missing session' });
					ws.close(1008, 'missing session');
					return;
				}
				void startSpectator(target, session);
				return;
			}

			const cols = clampSize(msg.cols, 80);
			const rows = clampSize(msg.rows, 24);
			void startSession(target, cols, rows);
			return;
		}

		// `image` 라우팅은 spectator/pty 분기보다 먼저 — 두 모드 모두에서
		// 동일하게 받아야 한다. handleImageMessage 안에서 sink(pty vs
		// spectator)를 다시 분기한다. (이전엔 spectator 블록의 무조건
		// return이 image까지 흡수해서 spectator 모드 업로드가 silently
		// drop되던 버그가 있었다.)
		if (msg.type === 'image') {
			if (typeof msg.mime === 'string' && typeof msg.data === 'string') {
				void handleImageMessage(msg.mime, msg.data);
			}
			return;
		}

		// Spectator mode: drop resize (bridge dictates size from tmux), but
		// allow `data` frames so the mobile "보내기" popup can inject
		// explicit keystrokes into the active pane via `send-keys -H`.
		// Scrolling is purely client-side over xterm.js's local scrollback
		// (mobile sees whatever it has received since attach) — the bridge
		// doesn't try to drive tmux copy-mode anymore: copy-mode operates
		// on the desktop's pane grid which the mobile has no access to,
		// and disturbing the desktop view for our scroll is worse than not
		// scrolling at all.
		if (subscription) {
			if (msg.type === 'data' && typeof msg.d === 'string') {
				subscription.sendInput(msg.d);
			} else if (msg.type === 'tmux-nav' && typeof msg.action === 'string') {
				if (msg.action === 'select-pane') {
					// Absolute jump to the Nth pane (1-based) of the current
					// window — backs the mobile footer's 1/2/3/4 buttons.
					if (
						typeof msg.index === 'number' &&
						Number.isInteger(msg.index) &&
						msg.index >= 1
					) {
						subscription.selectPane(msg.index);
					}
				} else if (TMUX_NAV_ACTIONS.has(msg.action)) {
					subscription.tmuxNav(msg.action as Parameters<SpectatorSubscription['tmuxNav']>[0]);
				}
			} else if (msg.type === 'subscribe-pane') {
				if (typeof msg.ordinal === 'number' && Number.isInteger(msg.ordinal)) {
					if (msg.ordinal === 0) {
						void subscription.unpin();
					} else if (msg.ordinal >= 1) {
						void subscription.pinOrdinal(msg.ordinal);
					}
					// else ignore (negative integers)
				}
			}
			return;
		}
		if (!pty) return;

		if (msg.type === 'data') {
			if (typeof msg.d === 'string') pty.write(msg.d);
			return;
		}
		if (msg.type === 'resize') {
			const cols = clampSize(msg.cols, 80);
			const rows = clampSize(msg.rows, 24);
			try {
				pty.resize(cols, rows);
			} catch {
				// PTY can be torn down between message and handler; ignore.
			}
			return;
		}
	});

	ws.on('close', (code, reason) => {
		console.log(`[ws] close code=${code} reason=${reason?.toString() || '(none)'}`);
		clearTimeout(authTimer);
		abortCtrl.abort();
		if (pty) {
			try { pty.kill(); } catch { /* ignore */ }
			pty = null;
		}
		if (subscription) {
			try { subscription.close(); } catch { /* ignore */ }
			subscription = null;
		}
		if (controlPath) {
			// ssh 마스터가 죽으면 소켓도 사라지지만 best-effort로 정리.
			unlink(controlPath).catch(() => { /* 이미 없음 */ });
			controlPath = null;
		}
	});

	async function startSpectator(target: SshTarget, session: string): Promise<void> {
		sessionTarget = target;
		const wol = lookupWolTarget(target.host);
		console.log(
			`[term-bridge] spectate target=${target.user ?? ''}@${target.host}:${target.port ?? 22} session=${session}`
		);
		if (wol) {
			const ok = await wakeIfNeeded(target, wol, abortCtrl.signal, send);
			if (!ok) {
				if (!abortCtrl.signal.aborted) {
					send({ type: 'error', message: 'wake_timeout' });
					try { ws.close(1011, 'wake timeout'); } catch { /* ignore */ }
				}
				return;
			}
		}
		if (abortCtrl.signal.aborted) return;
		subscription = SpectatorHubRegistry.subscribe(target, session, {
			paneSwitch: (info) => send({ type: 'pane-switch', ...info }),
			data: (d) => send({ type: 'data', d }),
			paneResize: (info) => send({ type: 'pane-resize', ...info }),
			paneUnavailable: (info) => send({ type: 'pane-unavailable', ...info }),
			error: (message) => send({ type: 'error', message }),
			exit: (reason) => {
				send({ type: 'exit', code: 0, reason });
				try { ws.close(1000, reason ?? 'spectator exit'); } catch { /* ignore */ }
			}
		}, { ctrlDir: CTRL_DIR });
		// hub-owned socket — server.ts does NOT take ownership of controlPath.
		if (abortCtrl.signal.aborted) {
			subscription.close();
			subscription = null;
			return;
		}
		// Await bootstrap — swallow error, bootstrap failure already fires error callback.
		await subscription.attach().catch(() => { /* bootstrap failure fires error callback */ });
		if (abortCtrl.signal.aborted) {
			subscription.close();
			subscription = null;
			return;
		}
		// PTY-ready signal — clients gate their UI on this. For spectator mode
		// we still send `ready` so the wsClient marks the session 'open'; the
		// first pane-switch + data frames arrive immediately after.
		send({ type: 'ready' });
	}

	async function startSession(target: SshTarget, cols: number, rows: number): Promise<void> {
		sessionTarget = target;
		// 원격 타깃만 ControlMaster — 로컬 셸 타깃은 ssh 자체가 없다.
		if (!isLocalTarget(target)) {
			controlPath = `${CTRL_DIR}/${randomUUID().slice(0, 8)}.sock`;
		}
		const wol = lookupWolTarget(target.host);
		console.log(`[term-bridge] connect target=${target.user ?? ''}@${target.host}:${target.port ?? 22} wol=${wol ? wol.mac : 'none'}`);
		if (wol) {
			const ok = await wakeIfNeeded(target, wol, abortCtrl.signal, send);
			if (!ok) {
				if (!abortCtrl.signal.aborted) {
					send({ type: 'error', message: 'wake_timeout' });
					try { ws.close(1011, 'wake timeout'); } catch { /* ignore */ }
				}
				return;
			}
		}
		if (abortCtrl.signal.aborted) return;
		try {
			pty = spawnForTarget(target, cols, rows, controlPath ?? undefined);
		} catch (err) {
			send({ type: 'error', message: `spawn failed: ${(err as Error).message}` });
			try { ws.close(1011, 'spawn failed'); } catch { /* ignore */ }
			return;
		}
		if (abortCtrl.signal.aborted) {
			try { pty.kill(); } catch { /* ignore */ }
			pty = null;
			return;
		}
		pty.onData((d) => send({ type: 'data', d }));
		pty.onExit(({ exitCode }) => {
			send({ type: 'exit', code: exitCode });
			ws.close(1000, 'pty exit');
		});
		// Signal PTY readiness — clients gate connect-script auto-run on this.
		// WS open alone is not enough: the data-message branch silently drops
		// frames that arrive before `pty` is non-null.
		send({ type: 'ready' });
	}

	/**
	 * `image` 메시지 처리 — base64 디코딩 → 타깃 호스트로 전송 → PTY 또는
	 * spectator 활성 패널에 경로를 bracketed-paste로 주입.
	 *
	 * - 셸 모드: pty.write(bracketedPaste(path) + ' ').
	 * - 관전 모드: subscription.sendInput(bracketedPaste(path) + ' ') → tmux send-keys -H.
	 * - 어느 쪽도 준비 안 된 race 상황: image-error 회신.
	 *
	 * 경로 뒤 공백 한 칸은 이미지를 연달아 붙여넣을 때 경로가 서로 붙지 않게 한다.
	 */
	async function handleImageMessage(mime: string, dataB64: string): Promise<void> {
		const started = Date.now();
		if (!sessionTarget) {
			console.log(`[image] reject ${mime}: no sessionTarget`);
			send({ type: 'image-error', message: '세션이 준비되지 않았습니다.' });
			return;
		}
		let bytes: Buffer;
		try {
			bytes = Buffer.from(dataB64, 'base64');
		} catch {
			console.log(`[image] reject ${mime}: base64 decode failed`);
			send({ type: 'image-error', message: '이미지 데이터가 올바르지 않습니다.' });
			return;
		}
		try {
			const { remotePath } = await transferImage({
				target: sessionTarget,
				controlPath: controlPath ?? subscription?.controlPath ?? null,
				mime,
				bytes
			});
			const paste = bracketedPaste(remotePath) + ' ';
			let sink: 'pty' | 'spectator';
			if (pty) {
				pty.write(paste);
				sink = 'pty';
			} else if (subscription?.hasActivePane()) {
				subscription.sendInput(paste);
				sink = 'spectator';
			} else {
				console.log(`[image] reject ${mime}: no active sink at inject time`);
				send({ type: 'image-error', message: '주입할 곳이 없습니다.' });
				return;
			}
			console.log(
				`[image] OK ${mime} ${bytes.length}B → ${remotePath} via ${sink} (${Date.now() - started}ms)`
			);
			send({ type: 'image-ok', path: remotePath });
		} catch (err) {
			const errMsg = (err as Error).message;
			console.log(`[image] FAIL ${mime} after ${Date.now() - started}ms — ${errMsg}`);
			send({ type: 'image-error', message: errMsg });
		}
	}
}

async function wakeIfNeeded(
	target: SshTarget,
	wol: WolEntry,
	signal: AbortSignal,
	send: (obj: unknown) => void
): Promise<boolean> {
	const port = target.port ?? 22;
	const reachable = await probePort(target.host, port, { timeoutMs: 1000, signal });
	console.log(`[term-bridge] WOL probe ${target.host}:${port} reachable=${reachable}`);
	if (reachable || signal.aborted) return reachable;
	send({ type: 'data', d: '\x1b[2m깨우는 중...\x1b[0m\r\n' });
	try {
		await sendMagicPacket(wol.mac, wol.broadcast);
		console.log(`[term-bridge] WOL magic packet sent mac=${wol.mac} broadcast=${wol.broadcast ?? '255.255.255.255'}`);
	} catch (err) {
		console.error('[term-bridge] WOL send failed:', err);
		// fall through — maybe the host is on its way up despite the send error
	}
	const timeoutMs = (wol.wakeTimeoutSec ?? 60) * 1000;
	const ok = await waitForPort(target.host, port, {
		timeoutMs,
		intervalMs: 1000,
		probeTimeoutMs: 1500,
		signal
	});
	console.log(`[term-bridge] WOL waitForPort result=${ok} (timeout was ${timeoutMs}ms)`);
	if (ok && !signal.aborted) {
		send({ type: 'data', d: '\x1b[2m연결 중...\x1b[0m\r\n' });
	}
	return ok;
}

function clampSize(v: unknown, fallback: number): number {
	const n = typeof v === 'number' ? Math.floor(v) : NaN;
	if (!Number.isFinite(n) || n < 1) return fallback;
	if (n > 1000) return 1000;
	return n;
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`[term-bridge] missing env: ${name}`);
		process.exit(1);
	}
	return v;
}
