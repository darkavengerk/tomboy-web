/**
 * 음악 노트별 재생 위치(이어듣기) 저장소.
 *
 * guid → { trackUrl, currentTime } 를 단일 localStorage 키에 직렬화한다. 노트 데이터가
 * 아니라 로컬 전용(브라우저 스코프, 동기 안 됨). 인메모리 맵(`mem`)이 진실 소스라
 * save 직후 load 가 동기로 최신값을 돌려준다(flush 대기 불필요) — 테스트/UI 모두 단순.
 * localStorage 는 영속 캐시일 뿐이며 throttled flush(5초) + 일시정지/정지/트랙변경/페이지
 * 숨김 시 즉시 flush 로 채운다.
 */

const STORAGE_KEY = 'tomboy.musicProgress';
const FLUSH_MS = 5000;

export interface ProgressEntry {
	trackUrl: string;
	currentTime: number;
}
type StoredEntry = ProgressEntry & { updatedAt: number };
type ProgressMap = Record<string, StoredEntry>;

function safeStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

function parseStored(): ProgressMap {
	const ls = safeStorage();
	if (!ls) return {};
	const raw = ls.getItem(STORAGE_KEY);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return {};
		const out: ProgressMap = {};
		for (const [guid, v] of Object.entries(parsed as Record<string, unknown>)) {
			const e = v as Record<string, unknown>;
			if (typeof e?.trackUrl === 'string' && typeof e?.currentTime === 'number') {
				out[guid] = {
					trackUrl: e.trackUrl,
					currentTime: e.currentTime,
					updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0
				};
			}
		}
		return out;
	} catch {
		return {};
	}
}

let mem: ProgressMap = parseStored();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let hideListenerInstalled = false;

function installHideFlush(): void {
	if (hideListenerInstalled || typeof window === 'undefined') return;
	hideListenerInstalled = true;
	window.addEventListener('pagehide', flushProgress);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flushProgress();
	});
}

function scheduleFlush(): void {
	installHideFlush();
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		flushProgress();
	}, FLUSH_MS);
}

/** 인메모리 맵을 localStorage 로 즉시 직렬화. 타이머도 해제. */
export function flushProgress(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	const ls = safeStorage();
	if (!ls) return;
	try {
		ls.setItem(STORAGE_KEY, JSON.stringify(mem));
	} catch {
		/* 쿼터 초과/비활성 — 인메모리만 유지(세션 동안은 동작) */
	}
}

/** 노트의 마지막 재생 트랙·위치 조회. 없으면 null. */
export function loadProgress(guid: string): ProgressEntry | null {
	const e = mem[guid];
	return e ? { trackUrl: e.trackUrl, currentTime: e.currentTime } : null;
}

/** 진행 위치 갱신(인메모리 즉시 + flush 예약). */
export function saveProgress(guid: string, trackUrl: string, currentTime: number): void {
	if (!guid || !trackUrl) return;
	mem[guid] = { trackUrl, currentTime: Math.max(0, currentTime), updatedAt: Date.now() };
	scheduleFlush();
}

/** 특정 노트 엔트리 제거(노트 삭제 청소용 — 알약 ✕ 는 이걸 호출하지 않는다). */
export function clearProgress(guid: string): void {
	if (mem[guid]) {
		delete mem[guid];
		scheduleFlush();
	}
}

/** 테스트 전용 — 인메모리 맵·타이머·localStorage 키를 모두 비운다. */
export function __resetMusicProgress(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	mem = {};
	const ls = safeStorage();
	try {
		ls?.removeItem(STORAGE_KEY);
	} catch {
		/* ignore */
	}
}
