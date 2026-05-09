import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
	extractBearer,
	mintToken,
	passwordMatches,
	verifyToken
} from './auth.js';
import { parseSshTarget, spawnForTarget, type SshTarget } from './pty.js';
import { loadHostsFile, lookupWolTarget, type WolEntry } from './hosts.js';
import { probePort, sendMagicPacket, waitForPort } from './wol.js';

const PORT = Number(process.env.BRIDGE_PORT || 3000);
const PASSWORD = requireEnv('BRIDGE_PASSWORD');
const SECRET = requireEnv('BRIDGE_SECRET');
const ALLOWED_ORIGIN = requireEnv('BRIDGE_ALLOWED_ORIGIN');
const HOSTS_FILE = process.env.BRIDGE_HOSTS_FILE;

loadHostsFile(HOSTS_FILE);

// Auth grace window after WebSocket open. The first client message MUST be
// a `connect` frame with a valid token; otherwise the connection is closed.
const AUTH_TIMEOUT_MS = 5000;

const server = createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true });

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
	type: 'connect' | 'data' | 'resize';
	target?: string;
	token?: string;
	cols?: number;
	rows?: number;
	d?: string;
}

function handleWs(ws: WebSocket): void {
	let pty: ReturnType<typeof spawnForTarget> | null = null;
	let connected = false;
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
		let msg: ClientMsg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
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
			const cols = clampSize(msg.cols, 80);
			const rows = clampSize(msg.rows, 24);
			// Mark connected early so duplicate `connect` frames during WOL
			// wait can't re-enter this branch.
			connected = true;
			clearTimeout(authTimer);
			void startSession(target, cols, rows);
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

	ws.on('close', () => {
		clearTimeout(authTimer);
		abortCtrl.abort();
		if (pty) {
			try { pty.kill(); } catch { /* ignore */ }
			pty = null;
		}
	});

	async function startSession(target: SshTarget, cols: number, rows: number): Promise<void> {
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
			pty = spawnForTarget(target, cols, rows);
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
