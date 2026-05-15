/**
 * Read/write the diary pipeline's per-page status docs at
 *   users/{uid}/diary-pipeline-pages/{pageUuid}
 *
 * The desktop pipeline writes these docs from `s4_write` (and backfills
 * once for already-processed pages). The web app's `/admin/remarkable`
 * page reads them for the status table and writes the `rerunRequested`
 * flag when the user asks to re-process a page.
 *
 * Schema (all fields optional except `pageUuid`, `tomboyGuid`,
 * `imageUrl`, `writtenAt` once the doc exists):
 *   {
 *     pageUuid: string,
 *     tomboyGuid: string,
 *     imageUrl: string,
 *     writtenAt: string (ISO),
 *     imageWidth?: number,
 *     imageHeight?: number,        // > 1872 → scroll-extended page
 *     ocrModel?: string,
 *     ocrCharCount?: number,
 *     ocrAt?: string (ISO),
 *     preparedAt?: string (ISO),
 *     lastModifiedMs?: number,     // from rM-side metadata.lastModified
 *     rerunRequested?: boolean,
 *     rerunRequestedAt?: string (ISO) | null,
 *   }
 */
import {
	collection,
	doc,
	getDocs,
	setDoc,
	type DocumentData
} from 'firebase/firestore';
import { ensureSignedIn, getFirebaseFirestore } from '$lib/firebase/app.js';

export interface DiaryPipelinePage {
	pageUuid: string;
	tomboyGuid: string;
	imageUrl: string;
	writtenAt: string;
	imageWidth?: number;
	imageHeight?: number;
	ocrModel?: string;
	ocrCharCount?: number;
	ocrAt?: string;
	preparedAt?: string;
	lastModifiedMs?: number;
	rerunRequested?: boolean;
	rerunRequestedAt?: string | null;
}

const COLLECTION = 'diary-pipeline-pages';

async function uid(): Promise<string> {
	const u = await ensureSignedIn();
	return u.uid;
}

function coerce(data: DocumentData, id: string): DiaryPipelinePage {
	return {
		pageUuid: typeof data.pageUuid === 'string' ? data.pageUuid : id,
		tomboyGuid: typeof data.tomboyGuid === 'string' ? data.tomboyGuid : '',
		imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : '',
		writtenAt: typeof data.writtenAt === 'string' ? data.writtenAt : '',
		imageWidth: typeof data.imageWidth === 'number' ? data.imageWidth : undefined,
		imageHeight: typeof data.imageHeight === 'number' ? data.imageHeight : undefined,
		ocrModel: typeof data.ocrModel === 'string' ? data.ocrModel : undefined,
		ocrCharCount: typeof data.ocrCharCount === 'number' ? data.ocrCharCount : undefined,
		ocrAt: typeof data.ocrAt === 'string' ? data.ocrAt : undefined,
		preparedAt: typeof data.preparedAt === 'string' ? data.preparedAt : undefined,
		lastModifiedMs:
			typeof data.lastModifiedMs === 'number' ? data.lastModifiedMs : undefined,
		rerunRequested:
			typeof data.rerunRequested === 'boolean' ? data.rerunRequested : undefined,
		rerunRequestedAt:
			typeof data.rerunRequestedAt === 'string'
				? data.rerunRequestedAt
				: data.rerunRequestedAt === null
					? null
					: undefined
	};
}

export async function listDiaryPages(): Promise<DiaryPipelinePage[]> {
	const u = await uid();
	const db = getFirebaseFirestore();
	const snap = await getDocs(collection(db, 'users', u, COLLECTION));
	const out: DiaryPipelinePage[] = [];
	snap.forEach((d) => out.push(coerce(d.data(), d.id)));
	// Sort by lastModifiedMs (rM mtime) desc — newest pages first. Falls
	// back to writtenAt for entries that predate the lastModifiedMs field.
	out.sort((a, b) => {
		const am = a.lastModifiedMs ?? (Date.parse(a.writtenAt) || 0);
		const bm = b.lastModifiedMs ?? (Date.parse(b.writtenAt) || 0);
		return bm - am;
	});
	return out;
}

export async function requestRerun(pageUuid: string): Promise<void> {
	const u = await uid();
	const db = getFirebaseFirestore();
	await setDoc(
		doc(db, 'users', u, COLLECTION, pageUuid),
		{
			rerunRequested: true,
			rerunRequestedAt: new Date().toISOString()
		},
		{ merge: true }
	);
}

export async function cancelRerun(pageUuid: string): Promise<void> {
	const u = await uid();
	const db = getFirebaseFirestore();
	await setDoc(
		doc(db, 'users', u, COLLECTION, pageUuid),
		{
			rerunRequested: false,
			rerunRequestedAt: null
		},
		{ merge: true }
	);
}

/** Heuristic: rendered PNG height > 1872 (one rM screen) means the user
 * scrolled while writing. Useful for the admin to spot pages that benefit
 * from the new dynamic-canvas renderer.  */
export function isScrollExtended(p: DiaryPipelinePage): boolean {
	return typeof p.imageHeight === 'number' && p.imageHeight > 1872;
}

// ── Desktop trigger ──────────────────────────────────────────────────
//
// Companion to `pipeline/desktop/trigger_server.py`. The browser posts
// here when the user clicks "재처리 요청" — the desktop spawns the
// pipeline in the background and returns 202 immediately.

export interface TriggerStatus {
	running: boolean;
	jobId?: string;
	startedAt?: string;
	finishedAt?: string;
	exitCode?: number;
	stdoutTail?: string;
	stderrTail?: string;
}

export interface TriggerResult {
	ok: boolean;
	started?: boolean;
	alreadyRunning?: boolean;
	status?: TriggerStatus;
	error?: string;
}

function normalizeBaseUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, '');
	return trimmed;
}

/** POST to ``<triggerUrl>/run`` with the Bearer token. Returns a
 * structured result the UI can render: success, already-running, network
 * error, or auth error. Never throws — callers reliably get a payload. */
export async function triggerPipelineRun(
	triggerUrl: string,
	token: string
): Promise<TriggerResult> {
	const base = normalizeBaseUrl(triggerUrl);
	if (!base) {
		return { ok: false, error: '트리거 URL이 설정되지 않았습니다' };
	}
	if (!token) {
		return { ok: false, error: '트리거 토큰이 설정되지 않았습니다' };
	}
	let res: Response;
	try {
		res = await fetch(base + '/run', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer ' + token,
				'Content-Type': 'application/json'
			},
			body: '{}'
		});
	} catch (e) {
		return { ok: false, error: '네트워크 오류: ' + String(e) };
	}
	let body: Record<string, unknown> = {};
	try {
		body = (await res.json()) as Record<string, unknown>;
	} catch {
		body = {};
	}
	if (res.status === 202) {
		return { ok: true, started: true, status: body as unknown as TriggerStatus };
	}
	if (res.status === 409) {
		return {
			ok: true,
			alreadyRunning: true,
			status: body as unknown as TriggerStatus
		};
	}
	if (res.status === 401) {
		return { ok: false, error: '인증 실패 (토큰 확인)' };
	}
	return {
		ok: false,
		error: 'HTTP ' + String(res.status) + ' ' + JSON.stringify(body)
	};
}

/** GET ``<triggerUrl>/status``. Used to refresh the live status panel. */
export async function fetchTriggerStatus(
	triggerUrl: string,
	token: string
): Promise<TriggerResult> {
	const base = normalizeBaseUrl(triggerUrl);
	if (!base || !token) {
		return { ok: false, error: 'not configured' };
	}
	let res: Response;
	try {
		res = await fetch(base + '/status', {
			headers: { Authorization: 'Bearer ' + token }
		});
	} catch (e) {
		return { ok: false, error: '네트워크 오류: ' + String(e) };
	}
	if (res.status !== 200) {
		return { ok: false, error: 'HTTP ' + String(res.status) };
	}
	try {
		const body = (await res.json()) as Record<string, unknown>;
		return { ok: true, status: body as unknown as TriggerStatus };
	} catch {
		return { ok: false, error: 'invalid JSON' };
	}
}

/** GET ``<triggerUrl>/health`` — no auth needed; used to verify URL is reachable. */
export async function pingTrigger(triggerUrl: string): Promise<boolean> {
	const base = normalizeBaseUrl(triggerUrl);
	if (!base) return false;
	try {
		const res = await fetch(base + '/health');
		return res.ok;
	} catch {
		return false;
	}
}
