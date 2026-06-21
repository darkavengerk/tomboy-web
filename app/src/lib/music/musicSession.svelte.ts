/**
 * 음악 세션(활성 노트 + 큐 + 인덱스) 지속 저장소. 노트 데이터가 아니라 로컬 전용.
 * 새로고침 후에도 마지막 세션을 복원해 레일 재생 컨트롤이 항상 동작하게 한다.
 * currentTime(이어듣기 위치)은 여기서 저장하지 않는다 — musicProgress 가 담당.
 */
import type { MusicTrack } from '$lib/music/parseMusicNote.js';
import { musicPlayer } from './musicPlayer.svelte.js';

const STORAGE_KEY = 'tomboy.musicSession';

export interface MusicSessionSnapshot {
	activeNoteGuid: string;
	activeNoteName: string;
	queue: MusicTrack[];
	currentIndex: number;
	/** 재생을 시작한 노트(레일 곡 제목 클릭 대상). 없으면 활성 노트로 폴백. */
	originNoteGuid?: string;
}

function safeStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

function isTrack(v: unknown): v is MusicTrack {
	const e = v as Record<string, unknown>;
	return !!e && typeof e.url === 'string' && typeof e.display === 'string';
}

export function loadSession(): MusicSessionSnapshot | null {
	const ls = safeStorage();
	if (!ls) return null;
	const raw = ls.getItem(STORAGE_KEY);
	if (!raw) return null;
	try {
		const p = JSON.parse(raw) as Record<string, unknown>;
		if (!p || typeof p !== 'object') return null;
		const guid = p.activeNoteGuid;
		const queue = p.queue;
		if (typeof guid !== 'string' || !Array.isArray(queue) || queue.length === 0) return null;
		if (!queue.every(isTrack)) return null;
		return {
			activeNoteGuid: guid,
			activeNoteName: typeof p.activeNoteName === 'string' ? p.activeNoteName : '',
			queue: queue as MusicTrack[],
			currentIndex: typeof p.currentIndex === 'number' ? p.currentIndex : 0,
			originNoteGuid: typeof p.originNoteGuid === 'string' ? p.originNoteGuid : undefined
		};
	} catch {
		return null;
	}
}

export function saveSession(snap: MusicSessionSnapshot | null): void {
	const ls = safeStorage();
	if (!ls) return;
	try {
		if (!snap || !snap.activeNoteGuid || snap.queue.length === 0) {
			ls.removeItem(STORAGE_KEY);
			return;
		}
		ls.setItem(STORAGE_KEY, JSON.stringify(snap));
	} catch {
		/* quota/denied — 무시 */
	}
}

/** 테스트 전용. */
export function __clearMusicSessionStorage(): void {
	safeStorage()?.removeItem(STORAGE_KEY);
}

/** 부팅 시 마지막 세션 복원 + 세션 식별 필드 변동 시 지속. +layout 에서 1회 설치. */
export function installMusicSession(): () => void {
	if (typeof window === 'undefined') return () => {};
	const snap = loadSession();
	if (snap) musicPlayer.restoreSession(snap);

	let timer: ReturnType<typeof setTimeout> | null = null;
	const stop = $effect.root(() => {
		$effect(() => {
			// 세션 식별 필드만 추적(currentTime 제외 — 저churn).
			const guid = musicPlayer.activeNoteGuid;
			const name = musicPlayer.activeNoteName;
			const q = musicPlayer.queue;
			const idx = musicPlayer.currentIndex;
			const origin = musicPlayer.originNoteGuid;
			const snapshot: MusicSessionSnapshot | null =
				guid && q.length > 0
					? {
							activeNoteGuid: guid,
							activeNoteName: name,
							queue: q,
							currentIndex: idx,
							originNoteGuid: origin ?? undefined
						}
					: null;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => saveSession(snapshot), 400);
		});
	});
	return () => {
		if (timer) clearTimeout(timer);
		stop();
	};
}
