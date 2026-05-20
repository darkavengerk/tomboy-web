import { verifyToken } from './auth.js';
import type { RemarkableHost } from './remarkableHosts.js';

export type { RemarkableHost };

export interface RmSlotFile {
	file: string;
	restart: boolean;
}

/**
 * 슬롯 id → /usr/share/remarkable/ 아래 기기 파일 + xochitl 재시작 필요 여부.
 * id 문자열은 app/src/lib/remarkable/slots.ts 의 RM_SLOT_LABELS 와 동기화 필수.
 */
export const RM_SLOT_FILES: Record<string, RmSlotFile> = {
	suspended: { file: 'suspended.png', restart: true },
	starting: { file: 'starting.png', restart: false },
	poweroff: { file: 'poweroff.png', restart: false },
	rebooting: { file: 'rebooting.png', restart: false },
	batteryempty: { file: 'batteryempty.png', restart: false }
};

export interface WallpaperScreen {
	slot: string;
	imageUrl: string;
}

export interface WallpaperDeps {
	hostsConfigured(): boolean;
	resolveHost(alias: string): RemarkableHost | null;
	fetchImage(url: string): Promise<Buffer>;
	convertImage(input: Buffer): Promise<Buffer>;
	pushFile(host: RemarkableHost, deviceFile: string, data: Buffer): Promise<void>;
	restartXochitl(host: RemarkableHost): Promise<void>;
}

export interface SlotResult {
	slot: string;
	status: 'ok' | 'error';
	message?: string;
}

export interface WallpaperOutcome {
	status: number;
	body: { results?: SlotResult[]; error?: string };
}

/**
 * 슬롯별로 페치→변환→전송. 한 슬롯의 실패는 격리되어 나머지를 막지 않는다.
 * 재시작 필요 슬롯이 하나라도 성공하면 마지막에 1회 restartXochitl.
 */
export async function applyWallpapers(
	deps: WallpaperDeps,
	alias: string,
	screens: WallpaperScreen[]
): Promise<WallpaperOutcome> {
	const host = deps.resolveHost(alias);
	if (!host) {
		return { status: 400, body: { error: 'unknown_host' } };
	}
	const results: SlotResult[] = [];
	let needRestart = false;
	for (const screen of screens) {
		// screen.slot 은 와이어에서 온 임의 문자열 — 미정의 슬롯 방어.
		const def = RM_SLOT_FILES[screen.slot];
		if (!def) {
			results.push({ slot: screen.slot, status: 'error', message: 'unknown_slot' });
			continue;
		}
		try {
			const raw = await deps.fetchImage(screen.imageUrl);
			const png = await deps.convertImage(raw);
			await deps.pushFile(host, def.file, png);
			results.push({ slot: screen.slot, status: 'ok' });
			if (def.restart) needRestart = true;
		} catch (err) {
			results.push({
				slot: screen.slot,
				status: 'error',
				message: (err as { message?: string }).message || 'failed'
			});
		}
	}
	if (needRestart) {
		try {
			await deps.restartXochitl(host);
		} catch (err) {
			console.error(
				'[term-bridge rm] xochitl restart failed:',
				(err as { message?: string }).message
			);
		}
	}
	return { status: 200, body: { results } };
}

export interface WallpaperRequestInput {
	token: string | undefined;
	secret: string;
	body: unknown;
	deps: WallpaperDeps;
}

/** 인증 → 구성 확인 → 본문 검증 → applyWallpapers. */
export async function processWallpaperRequest(
	input: WallpaperRequestInput
): Promise<WallpaperOutcome> {
	if (!verifyToken(input.secret, input.token)) {
		return { status: 401, body: { error: 'unauthorized' } };
	}
	if (!input.deps.hostsConfigured()) {
		return { status: 503, body: { error: 'remarkable_not_configured' } };
	}
	const parsed = parseBody(input.body);
	if (!parsed) {
		return { status: 400, body: { error: 'bad_request' } };
	}
	return applyWallpapers(input.deps, parsed.host, parsed.screens);
}

function parseBody(body: unknown): { host: string; screens: WallpaperScreen[] } | null {
	if (!body || typeof body !== 'object') return null;
	const b = body as Record<string, unknown>;
	if (typeof b.host !== 'string' || !b.host.trim()) return null;
	// 정의된 슬롯은 5개 — 봉투 단계에서는 8개까지 여유분으로 허용(향후 슬롯 대비).
	if (!Array.isArray(b.screens) || b.screens.length === 0 || b.screens.length > 8) return null;
	const screens: WallpaperScreen[] = [];
	for (const s of b.screens) {
		if (!s || typeof s !== 'object') return null;
		const slot = (s as Record<string, unknown>).slot;
		const imageUrl = (s as Record<string, unknown>).imageUrl;
		if (typeof slot !== 'string' || typeof imageUrl !== 'string') return null;
		if (!/^https?:\/\//i.test(imageUrl)) return null;
		screens.push({ slot, imageUrl });
	}
	return { host: b.host.trim(), screens };
}
