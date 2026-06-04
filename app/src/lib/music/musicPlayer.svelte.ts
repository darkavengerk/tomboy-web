import type { MusicTrack } from '$lib/music/parseMusicNote.js';

let queue = $state<MusicTrack[]>([]);
let currentIndex = $state(-1);
let isPlaying = $state(false);
let currentTime = $state(0);
let duration = $state(0);
let activeNoteGuid = $state<string | null>(null);
let seekToken = $state(0);
let pendingSeekTime = $state(0);

function clampIndex(i: number): number {
	if (queue.length === 0) return -1;
	return Math.max(0, Math.min(i, queue.length - 1));
}

/** 테스트 전용 — 모듈 싱글톤 상태 초기화. */
export function __resetMusicPlayer(): void {
	queue = [];
	currentIndex = -1;
	isPlaying = false;
	currentTime = 0;
	duration = 0;
	activeNoteGuid = null;
	seekToken = 0;
	pendingSeekTime = 0;
}

export const musicPlayer = {
	get queue() {
		return queue;
	},
	get currentIndex() {
		return currentIndex;
	},
	get isPlaying() {
		return isPlaying;
	},
	get currentTime() {
		return currentTime;
	},
	get duration() {
		return duration;
	},
	get seekToken() {
		return seekToken;
	},
	get pendingSeekTime() {
		return pendingSeekTime;
	},
	get currentTrack(): MusicTrack | null {
		return queue[currentIndex] ?? null;
	},

	/** doc 재파싱 결과를 반영. 같은 노트면 재생 중 url 로 index 보존. */
	setQueue(noteGuid: string, tracks: MusicTrack[]): void {
		const sameNote = noteGuid === activeNoteGuid;
		const prevUrl = sameNote ? (queue[currentIndex]?.url ?? null) : null;
		queue = tracks;
		activeNoteGuid = noteGuid;
		let idx = prevUrl ? tracks.findIndex((t) => t.url === prevUrl) : -1;
		if (idx === -1) {
			idx = tracks.length ? 0 : -1;
			isPlaying = false;
			currentTime = 0;
			duration = 0;
		}
		currentIndex = idx;
	},

	play(index: number): void {
		if (queue.length === 0) return;
		const i = clampIndex(index);
		if (i !== currentIndex) {
			currentIndex = i;
			currentTime = 0;
		}
		isPlaying = true;
	},

	toggle(): void {
		if (currentIndex < 0) {
			if (queue.length) this.play(0);
			return;
		}
		isPlaying = !isPlaying;
	},

	next(): void {
		if (currentIndex + 1 < queue.length) this.play(currentIndex + 1);
		else isPlaying = false;
	},

	prev(): void {
		if (currentIndex > 0) this.play(currentIndex - 1);
		else this.requestSeek(0);
	},

	requestSeek(t: number): void {
		pendingSeekTime = Math.max(0, t);
		currentTime = pendingSeekTime;
		seekToken = (seekToken + 1) | 0;
	},

	reportTime(t: number): void {
		currentTime = t;
	},
	reportDuration(d: number): void {
		duration = Number.isFinite(d) ? d : 0;
	},
	reportEnded(): void {
		this.next();
	}
};
