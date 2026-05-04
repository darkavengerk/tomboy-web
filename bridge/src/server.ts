import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
	COOKIE_MAX_AGE_SEC,
	COOKIE_NAME,
	mintToken,
	parseCookies,
	passwordMatches,
	verifyToken
} from './auth.js';
import { parseSshTarget, spawnForTarget } from './pty.js';

const PORT = Number(process.env.BRIDGE_PORT || 3000);
const PASSWORD = requireEnv('BRIDGE_PASSWORD');
const SECRET = requireEnv('BRIDGE_SECRET');
const ALLOWED_ORIGIN = requireEnv('BRIDGE_ALLOWED_ORIGIN');
// Caddy / nginx in front of us terminates TLS and is responsible for the
// `Secure` cookie attribute making sense. We always set Secure; if you
// genuinely need plain-HTTP for local testing, strip it in your proxy.

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
	const cookies = parseCookies(req.headers.cookie);
	if (!verifyToken(SECRET, cookies[COOKIE_NAME])) {
		socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
		socket.destroy();
		return;
	}
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
		const cookies = parseCookies(req.headers.cookie);
		const ok = verifyToken(SECRET, cookies[COOKIE_NAME]);
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
		res.setHeader('Set-Cookie', cookieValue(token, COOKIE_MAX_AGE_SEC));
		res.writeHead(204).end();
		return;
	}

	if (url === '/logout' && req.method === 'POST') {
		res.setHeader('Set-Cookie', cookieValue('', 0));
		res.writeHead(204).end();
		return;
	}

	res.writeHead(404).end();
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
	const origin = req.headers.origin;
	if (origin && originAllowed(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Access-Control-Allow-Credentials', 'true');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
		res.setHeader('Vary', 'Origin');
	}
}

function originAllowed(origin: string | undefined): boolean {
	if (!origin) return false;
	return ALLOWED_ORIGIN.split(',').some((o) => o.trim() === origin);
}

function cookieValue(token: string, maxAgeSec: number): string {
	const parts = [
		`${COOKIE_NAME}=${token}`,
		'HttpOnly',
		'Secure',
		'SameSite=None',
		'Path=/',
		`Max-Age=${maxAgeSec}`
	];
	return parts.join('; ');
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
	cols?: number;
	rows?: number;
	d?: string;
}

function handleWs(ws: WebSocket): void {
	let pty: ReturnType<typeof spawnForTarget> | null = null;
	let connected = false;

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
			const target = parseSshTarget(String(msg.target ?? ''));
			if (!target) {
				send({ type: 'error', message: 'invalid target' });
				ws.close(1008, 'invalid target');
				return;
			}
			const cols = clampSize(msg.cols, 80);
			const rows = clampSize(msg.rows, 24);
			try {
				pty = spawnForTarget(target, cols, rows);
			} catch (err) {
				send({ type: 'error', message: `spawn failed: ${(err as Error).message}` });
				ws.close(1011, 'spawn failed');
				return;
			}
			connected = true;
			pty.onData((d) => send({ type: 'data', d }));
			pty.onExit(({ exitCode }) => {
				send({ type: 'exit', code: exitCode });
				ws.close(1000, 'pty exit');
			});
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
		if (pty) {
			try { pty.kill(); } catch { /* ignore */ }
			pty = null;
		}
	});
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
