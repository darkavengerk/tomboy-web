import type { MusicTrack } from '$lib/music/parseMusicNote.js';

export type RepeatMode = 'off' | 'all' | 'one';

let queue = $state<MusicTrack[]>([]);
let currentIndex = $state(-1);
let isPlaying = $state(false);
let currentTime = $state(0);
let duration = $state(0);
let activeNoteGuid = $state<string | null>(null);
let activeNoteName = $state('');
let seekToken = $state(0);
let pendingSeekTime = $state(0);
let repeat = $state<RepeatMode>('off');
let shuffle = $state(false);
// shuffle 시 재생 순서(큐 인덱스의 순열). shuffle off 면 무시.
let shuffleOrder = $state<number[]>([]);

function clampIndex(i: number): number {
	if (queue.length === 0) return -1;
	return Math.max(0, Math.min(i, queue.length - 1));
}

/** Fisher-Yates 로 shuffleOrder 재생성. keepCurrentFirst 면 현재 곡을 0번에 고정
 *  (shuffle 켜는 순간 지금 곡이 튀지 않게). 한 바퀴 다 돌아 reshuffle 할 땐 false. */
function rebuildShuffle(keepCurrentFirst: boolean): void {
	const n = queue.length;
	const arr: number[] = [];
	for (let i = 0; i < n; i++) arr.push(i);
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const tmp = arr[i];
		arr[i] = arr[j];
		arr[j] = tmp;
	}
	if (keepCurrentFirst && currentIndex >= 0) {
		const k = arr.indexOf(currentIndex);
		if (k > 0) {
			const tmp = arr[0];
			arr[0] = arr[k];
			arr[k] = tmp;
		}
	}
	shuffleOrder = arr;
}

/** 현재 재생 순서(인덱스 배열). shuffle 이고 순서가 큐와 길이 맞으면 shuffleOrder, 아니면 정순. */
function playOrder(): number[] {
	if (shuffle && shuffleOrder.length === queue.length && queue.length > 0) return shuffleOrder;
	return queue.map((_, i) => i);
}

/** 현재 곡 기준 dir(+1/-1) 칸 이동한 큐 인덱스. 끝을 넘고 wrap 이면 감싸기(shuffle 은 reshuffle),
 *  아니면 null(정지 신호). */
function stepIndex(dir: 1 | -1, wrap: boolean): number | null {
	const ord = playOrder();
	if (ord.length === 0) return null;
	const pos = ord.indexOf(currentIndex);
	if (pos === -1) return ord[0];
	const np = pos + dir;
	if (np < 0) return null;
	if (np >= ord.length) {
		if (!wrap) return null;
		if (shuffle) {
			rebuildShuffle(false);
			return shuffleOrder[0] ?? null;
		}
		return ord[0] ?? null;
	}
	return ord[np];
}

/** 테스트 전용 — 모듈 싱글톤 상태 초기화. */
export function __resetMusicPlayer(): void {
	queue = [];
	currentIndex = -1;
	isPlaying = false;
	currentTime = 0;
	duration = 0;
	activeNoteGuid = null;
	activeNoteName = '';
	seekToken = 0;
	pendingSeekTime = 0;
	repeat = 'off';
	shuffle = false;
	shuffleOrder = [];
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
	/** 현재 활성(재생/큐) 노트의 guid — 그 노트의 패널만 편집 시 큐를 재동기화. */
	get activeNoteGuid(): string | null {
		return activeNoteGuid;
	},
	/** 현재 활성 노트 이름 — 미디어세션 album. */
	get activeNoteName(): string {
		return activeNoteName;
	},
	/** 반복 모드: off → 끝나면 정지, all → 큐 끝에서 처음으로, one → 한 곡 무한. */
	get repeat(): RepeatMode {
		return repeat;
	},
	/** 랜덤 섞기 on/off. */
	get shuffle(): boolean {
		return shuffle;
	},

	/** doc 재파싱 결과를 반영. 같은 노트면 재생 중 url 로 index 보존. */
	setQueue(noteGuid: string, tracks: MusicTrack[], noteName = ''): void {
		const sameNote = noteGuid === activeNoteGuid;
		const prevUrl = sameNote ? (queue[currentIndex]?.url ?? null) : null;
		queue = tracks;
		activeNoteGuid = noteGuid;
		activeNoteName = noteName;
		let idx = prevUrl ? tracks.findIndex((t) => t.url === prevUrl) : -1;
		if (idx === -1) {
			idx = tracks.length ? 0 : -1;
			isPlaying = false;
			currentTime = 0;
			duration = 0;
		}
		currentIndex = idx;
		// 큐가 바뀌었으니 섞기 순서도 새로 — 현재 곡을 0번에 고정.
		if (shuffle) rebuildShuffle(true);
	},

	/** 반복 모드 순환: off → all → one → off. */
	cycleRepeat(): void {
		repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
	},

	/** 랜덤 섞기 토글. 켜는 순간 현재 곡 기준으로 순서를 새로 섞는다. */
	toggleShuffle(): void {
		shuffle = !shuffle;
		if (shuffle) rebuildShuffle(true);
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

	pause(): void {
		isPlaying = false;
	},

	toggle(): void {
		if (currentIndex < 0) {
			if (queue.length) this.play(0);
			return;
		}
		isPlaying = !isPlaying;
	},

	next(): void {
		// 사용자 ⏭ — 반복-전체면 끝에서 처음으로 감싼다. (shuffle 은 섞인 순서 기준.)
		const i = stepIndex(1, repeat === 'all');
		if (i == null) {
			isPlaying = false;
			return;
		}
		this.play(i);
	},

	prev(): void {
		const ord = playOrder();
		const pos = ord.indexOf(currentIndex);
		if (pos > 0) this.play(ord[pos - 1]);
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
		// 자동 넘김 — 반복-하나면 같은 곡 처음부터, 아니면 다음(반복-전체는 감싸기).
		if (queue.length === 0) {
			isPlaying = false;
			return;
		}
		if (repeat === 'one' && currentIndex >= 0) {
			this.requestSeek(0);
			isPlaying = true;
			return;
		}
		const i = stepIndex(1, repeat === 'all');
		if (i == null) {
			isPlaying = false;
			return;
		}
		// 한 곡짜리 반복-전체: 다음 인덱스가 현재와 같으면 play() 가 시간을 안 되감으니 직접.
		if (i === currentIndex) {
			this.requestSeek(0);
			isPlaying = true;
			return;
		}
		this.play(i);
	}
};
