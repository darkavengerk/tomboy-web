import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken,
	bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type StatusErrorKind =
	| 'not_configured'
	| 'unauthorized'
	| 'service_unavailable'
	| 'bad_request'
	| 'upstream_error'
	| 'network';

export class BridgeStatusError extends Error {
	constructor(
		public kind: StatusErrorKind,
		public detail?: string
	) {
		super(`${kind}${detail ? `: ${detail}` : ''}`);
	}
}

export interface ServiceProbe {
	name: string;
	status: 'up' | 'down' | 'unconfigured';
	latency_ms: number | null;
}

export interface DiskInfo {
	mount: string;
	size_bytes: number;
	used_bytes: number;
	avail_bytes: number;
	use_pct: number;
}

export interface BridgeStatus {
	fetched_at: string;
	system: {
		uptime_s: number;
		load: number[];
		cpu_count: number;
		cpu_temp_c: number | null;
		mem_total_bytes: number;
		mem_used_bytes: number;
	};
	disks: DiskInfo[];
	services: ServiceProbe[];
	files: { count: number; total_bytes: number; latest_mtime: string | null };
	connections: {
		spectator_sessions: number;
		folder_cache: number;
		hosts_ssh: number;
		hosts_remarkable: number;
		hosts_wol: number;
	};
	bridge: { port: number; uptime_s: number; node: string; public_host: string };
}

const STATUS_TO_KIND: Record<number, StatusErrorKind> = {
	401: 'unauthorized',
	503: 'service_unavailable'
};

/** GET /status — 브릿지 현황 집계를 받아온다. 설정/인증/네트워크 오류는 분류해 throw. */
export async function fetchBridgeStatus(opts?: { signal?: AbortSignal }): Promise<BridgeStatus> {
	const bridge = await getDefaultTerminalBridge();
	const token = await getTerminalBridgeToken();
	if (!bridge || !token) throw new BridgeStatusError('not_configured', '브릿지 설정이 필요합니다');
	const url = `${bridgeToHttpBase(bridge)}/status`;

	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: opts?.signal
		});
	} catch (err) {
		throw new BridgeStatusError('network', (err as Error).message);
	}

	if (!res.ok) {
		const kind = STATUS_TO_KIND[res.status] ?? (res.status >= 500 ? 'upstream_error' : 'bad_request');
		throw new BridgeStatusError(kind);
	}

	let data: unknown;
	try {
		data = await res.json();
	} catch (err) {
		throw new BridgeStatusError('upstream_error', (err as Error).message);
	}
	if (!data || typeof data !== 'object') throw new BridgeStatusError('upstream_error', 'bad_shape');
	return data as BridgeStatus;
}
