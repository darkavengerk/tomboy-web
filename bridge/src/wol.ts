import { createSocket } from 'node:dgram';
import { connect as netConnect } from 'node:net';

const WOL_PORT = 9;
const DEFAULT_BROADCAST = '255.255.255.255';

export function sendMagicPacket(mac: string, broadcast?: string): Promise<void> {
	const bytes = macToBytes(mac);
	const packet = Buffer.alloc(6 + 16 * 6);
	packet.fill(0xff, 0, 6);
	for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6);
	const target = broadcast || DEFAULT_BROADCAST;
	return new Promise((resolve, reject) => {
		const sock = createSocket('udp4');
		sock.once('error', (err) => {
			sock.close();
			reject(err);
		});
		sock.bind(0, () => {
			try {
				sock.setBroadcast(true);
			} catch (err) {
				sock.close();
				reject(err);
				return;
			}
			sock.send(packet, 0, packet.length, WOL_PORT, target, (err) => {
				sock.close();
				if (err) reject(err);
				else resolve();
			});
		});
	});
}

function macToBytes(mac: string): Buffer {
	const cleaned = mac.replace(/[:-]/g, '');
	if (cleaned.length !== 12) throw new Error(`bad mac: ${mac}`);
	return Buffer.from(cleaned, 'hex');
}

export interface ProbeOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export function probePort(host: string, port: number, opts: ProbeOptions = {}): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? 1000;
	return new Promise((resolve) => {
		if (opts.signal?.aborted) {
			resolve(false);
			return;
		}
		const sock = netConnect({ host, port });
		let done = false;
		const finish = (ok: boolean): void => {
			if (done) return;
			done = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		const onAbort = (): void => finish(false);
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		sock.once('connect', () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			finish(true);
		});
		sock.once('error', () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			finish(false);
		});
	});
}

export interface WaitForPortOptions {
	timeoutMs: number;
	intervalMs?: number;
	probeTimeoutMs?: number;
	signal?: AbortSignal;
}

export async function waitForPort(host: string, port: number, opts: WaitForPortOptions): Promise<boolean> {
	const interval = opts.intervalMs ?? 1000;
	const probeTimeout = opts.probeTimeoutMs ?? 1000;
	const deadline = Date.now() + opts.timeoutMs;
	while (Date.now() < deadline) {
		if (opts.signal?.aborted) return false;
		const ok = await probePort(host, port, { timeoutMs: probeTimeout, signal: opts.signal });
		if (ok) return true;
		if (opts.signal?.aborted) return false;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await sleep(Math.min(interval, remaining), opts.signal);
	}
	return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(t);
			resolve();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
