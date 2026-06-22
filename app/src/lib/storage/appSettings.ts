import { getDB } from './db.js';
import {
	CLAUDE_HEADER_DEFAULTS,
	CLAUDE_VALID_EFFORTS
} from '../chatNote/defaults.js';

interface Row<T> {
	id: string;
	value: T;
}

export async function getSetting<T>(id: string): Promise<T | undefined> {
	const db = await getDB();
	const row = (await db.get('appSettings', id)) as Row<T> | undefined;
	return row?.value;
}

export async function setSetting<T>(id: string, value: T): Promise<void> {
	const db = await getDB();
	await db.put('appSettings', { id, value });
}

export async function deleteSetting(id: string): Promise<void> {
	const db = await getDB();
	await db.delete('appSettings', id);
}

/** Read every row from appSettings. */
export async function getAllSettings(): Promise<Array<{ id: string; value: unknown }>> {
	const db = await getDB();
	const rows = (await db.getAll('appSettings')) as Array<{ id: string; value: unknown }>;
	return rows;
}

/** Replace the whole appSettings store with the provided rows. */
export async function replaceAllSettings(
	rows: Array<{ id: string; value: unknown }>
): Promise<void> {
	const db = await getDB();
	const tx = db.transaction('appSettings', 'readwrite');
	await tx.store.clear();
	for (const row of rows) {
		await tx.store.put(row);
	}
	await tx.done;
}

// ── Terminal history settings ────────────────────────────────────────

const TERM_HIST_OPEN_DESKTOP = 'terminalHistoryPanelOpenDesktop';
const TERM_HIST_OPEN_MOBILE = 'terminalHistoryPanelOpenMobile';
const TERM_HIST_BLOCKLIST = 'terminalHistoryBlocklist';
const TERM_HIST_BANNER_DISMISSED = 'terminalShellIntegrationBannerDismissed';

export const TERMINAL_HISTORY_BLOCKLIST_DEFAULT: string[] = [
	'ls', 'cd', 'pwd', 'clear', 'cls', 'exit', 'logout', 'whoami', 'date', 'history'
];

export async function getTerminalHistoryPanelOpenDesktop(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_OPEN_DESKTOP);
	return typeof v === 'boolean' ? v : true;
}

export async function setTerminalHistoryPanelOpenDesktop(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_OPEN_DESKTOP, value);
}

export async function getTerminalHistoryPanelOpenMobile(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_OPEN_MOBILE);
	return typeof v === 'boolean' ? v : false;
}

export async function setTerminalHistoryPanelOpenMobile(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_OPEN_MOBILE, value);
}

export async function getTerminalHistoryBlocklist(): Promise<string[]> {
	const v = await getSetting<unknown>(TERM_HIST_BLOCKLIST);
	if (!Array.isArray(v)) return [...TERMINAL_HISTORY_BLOCKLIST_DEFAULT];
	const out: string[] = [];
	for (const item of v) {
		if (typeof item === 'string' && item.trim() !== '') out.push(item.trim());
	}
	return out.length > 0 ? out : [...TERMINAL_HISTORY_BLOCKLIST_DEFAULT];
}

export async function setTerminalHistoryBlocklist(value: string[]): Promise<void> {
	await setSetting(TERM_HIST_BLOCKLIST, value);
}

export async function getTerminalShellIntegrationBannerDismissed(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_HIST_BANNER_DISMISSED);
	return typeof v === 'boolean' ? v : false;
}

export async function setTerminalShellIntegrationBannerDismissed(value: boolean): Promise<void> {
	await setSetting(TERM_HIST_BANNER_DISMISSED, value);
}

const TERM_BELL_ENABLED = 'terminalBellEnabled';

export async function getTerminalBellEnabled(): Promise<boolean> {
	const v = await getSetting<boolean>(TERM_BELL_ENABLED);
	return typeof v === 'boolean' ? v : true;
}

export async function setTerminalBellEnabled(value: boolean): Promise<void> {
	await setSetting(TERM_BELL_ENABLED, value);
}

// ── Diary pipeline trigger settings ──────────────────────────────────
//
// The /admin/remarkable page can be configured with the URL of a
// desktop-side trigger service (see pipeline/desktop/trigger_server.py)
// and the Bearer token it expects. When set, clicking "재처리 요청"
// fires off the Firestore flag AND POSTs to the trigger URL so the
// pipeline runs immediately instead of waiting for a manual desktop run.

const DIARY_TRIGGER_URL = 'diaryTriggerUrl';
const DIARY_TRIGGER_TOKEN = 'diaryTriggerToken';

export async function getDiaryTriggerUrl(): Promise<string> {
	const v = await getSetting<string>(DIARY_TRIGGER_URL);
	return typeof v === 'string' ? v : '';
}

export async function setDiaryTriggerUrl(value: string): Promise<void> {
	await setSetting(DIARY_TRIGGER_URL, value);
}

export async function getDiaryTriggerToken(): Promise<string> {
	const v = await getSetting<string>(DIARY_TRIGGER_TOKEN);
	return typeof v === 'string' ? v : '';
}

export async function setDiaryTriggerToken(value: string): Promise<void> {
	await setSetting(DIARY_TRIGGER_TOKEN, value);
}

// ── Image storage (Vercel Blob) settings ─────────────────────────────
//
// Bearer token shared with the `/api/temp-image/*` SvelteKit endpoints.
// Must byte-match `IMAGE_STORAGE_TOKEN` env var on the server side.

const IMAGE_STORAGE_TOKEN = 'imageStorageToken';

export async function getImageStorageToken(): Promise<string> {
	const v = await getSetting<string>(IMAGE_STORAGE_TOKEN);
	return typeof v === 'string' ? v : '';
}

export async function setImageStorageToken(value: string): Promise<void> {
	await setSetting(IMAGE_STORAGE_TOKEN, value);
}

// ── Image cache settings ──────────────────────────────────────────────

const KEY_IMAGE_CACHE_TOTAL_BYTES = 'imageCacheTotalBytes';
const KEY_IMAGE_CACHE_QUOTA_BYTES = 'imageCacheQuotaBytes';
const DEFAULT_IMAGE_CACHE_QUOTA = 500 * 1024 * 1024; // 500 MB

export async function getImageCacheTotalBytes(): Promise<number> {
	const v = await getSetting<number>(KEY_IMAGE_CACHE_TOTAL_BYTES);
	return typeof v === 'number' ? v : 0;
}

export async function setImageCacheTotalBytes(bytes: number): Promise<void> {
	await setSetting(KEY_IMAGE_CACHE_TOTAL_BYTES, Math.max(0, bytes));
}

export async function getImageCacheQuotaBytes(): Promise<number> {
	const v = await getSetting<number>(KEY_IMAGE_CACHE_QUOTA_BYTES);
	return typeof v === 'number' && v > 0 ? v : DEFAULT_IMAGE_CACHE_QUOTA;
}

export async function setImageCacheQuotaBytes(bytes: number): Promise<void> {
	await setSetting(KEY_IMAGE_CACHE_QUOTA_BYTES, Math.max(0, bytes));
}

// ── Claude chat-note default settings ─────────────────────────────────
//
// Injected into the auto-written header of new claude:// notes and used as
// the send-time fallback when a note omits a field. User-editable in
// 설정 → Claude. Single source of truth for the fallback values is
// CLAUDE_HEADER_DEFAULTS in chatNote/defaults.ts.

const CLAUDE_DEFAULT_SYSTEM = 'claudeDefaultSystem';
const CLAUDE_DEFAULT_MODEL = 'claudeDefaultModel';
const CLAUDE_DEFAULT_EFFORT = 'claudeDefaultEffort';

export async function getClaudeDefaultSystem(): Promise<string> {
	const v = await getSetting<string>(CLAUDE_DEFAULT_SYSTEM);
	return typeof v === 'string' ? v : CLAUDE_HEADER_DEFAULTS.system;
}

export async function setClaudeDefaultSystem(value: string): Promise<void> {
	await setSetting(CLAUDE_DEFAULT_SYSTEM, value);
}

export async function getClaudeDefaultModel(): Promise<string> {
	const v = await getSetting<string>(CLAUDE_DEFAULT_MODEL);
	return typeof v === 'string' && v.trim() !== '' ? v.trim() : CLAUDE_HEADER_DEFAULTS.model;
}

export async function setClaudeDefaultModel(value: string): Promise<void> {
	await setSetting(CLAUDE_DEFAULT_MODEL, value);
}

export async function getClaudeDefaultEffort(): Promise<string> {
	const v = await getSetting<string>(CLAUDE_DEFAULT_EFFORT);
	return (CLAUDE_VALID_EFFORTS as readonly string[]).includes(v ?? '')
		? (v as string)
		: CLAUDE_HEADER_DEFAULTS.effort;
}

export async function setClaudeDefaultEffort(value: string): Promise<void> {
	await setSetting(CLAUDE_DEFAULT_EFFORT, value);
}

// ── reMarkable send-PDF defaults ──────────────────────────────────────
//
// 노트 → 리마커블 PDF 송출 시 사용할 별칭별 기본 폴더. folderName 은 사용자
// 표시 라벨, folderUuid 는 브릿지가 `.metadata` 스캔으로 찾아준 캐시 값.
// 폴더 이동/이름 변경으로 uuid 가 stale 해지면 송출 시 브릿지가 folderName
// 으로 재해석한다. 별칭이 둘 이상일 수 있어 Record<alias, …> 모양으로 저장.

const REMARKABLE_SEND_DEFAULTS = 'remarkableSendDefaults';

export interface RemarkableSendDefault {
	folderName: string;
	folderUuid: string;
}

function sanitizeRemarkableSendDefault(v: unknown): RemarkableSendDefault | null {
	if (!v || typeof v !== 'object') return null;
	const r = v as Record<string, unknown>;
	if (typeof r.folderName !== 'string' || typeof r.folderUuid !== 'string') return null;
	return { folderName: r.folderName, folderUuid: r.folderUuid };
}

export async function getRemarkableSendDefault(
	alias: string
): Promise<RemarkableSendDefault | undefined> {
	const all = await getSetting<Record<string, unknown>>(REMARKABLE_SEND_DEFAULTS);
	if (!all || typeof all !== 'object') return undefined;
	const entry = sanitizeRemarkableSendDefault(all[alias]);
	return entry ?? undefined;
}

export async function setRemarkableSendDefault(
	alias: string,
	value: RemarkableSendDefault
): Promise<void> {
	const existing =
		(await getSetting<Record<string, unknown>>(REMARKABLE_SEND_DEFAULTS)) ?? {};
	existing[alias] = { folderName: value.folderName, folderUuid: value.folderUuid };
	await setSetting(REMARKABLE_SEND_DEFAULTS, existing);
}

export async function clearRemarkableSendDefault(alias: string): Promise<void> {
	const existing =
		(await getSetting<Record<string, unknown>>(REMARKABLE_SEND_DEFAULTS)) ?? {};
	delete existing[alias];
	await setSetting(REMARKABLE_SEND_DEFAULTS, existing);
}

export async function getAllRemarkableSendDefaults(): Promise<
	Record<string, RemarkableSendDefault>
> {
	const all = await getSetting<Record<string, unknown>>(REMARKABLE_SEND_DEFAULTS);
	if (!all || typeof all !== 'object') return {};
	const out: Record<string, RemarkableSendDefault> = {};
	for (const [alias, raw] of Object.entries(all)) {
		const entry = sanitizeRemarkableSendDefault(raw);
		if (entry) out[alias] = entry;
	}
	return out;
}

// ── Device name (기기 이름) ───────────────────────────────────────────
// User-set label for THIS device/browser. Used by the 음악제어:: control note
// to label per-device playback records. Generic on purpose (future reuse).

const DEVICE_NAME = 'deviceName';

export async function getDeviceName(): Promise<string> {
	const v = await getSetting<string>(DEVICE_NAME);
	return typeof v === 'string' ? v : '';
}

export async function setDeviceName(value: string): Promise<void> {
	await setSetting(DEVICE_NAME, value.trim());
}
