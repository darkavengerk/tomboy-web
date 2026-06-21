import type { MusicTrack } from '$lib/music/parseMusicNote.js';
import { saveProgress, loadProgress, flushProgress } from './musicProgress.js';

export type RepeatMode = 'off' | 'all' | 'one';

let queue = $state<MusicTrack[]>([]);
let currentIndex = $state(-1);
let isPlaying = $state(false);
let currentTime = $state(0);
let duration = $state(0);
let activeNoteGuid = $state<string | null>(null);
let activeNoteName = $state('');
// 재생을 *시작한* 노트(레일 곡 제목 클릭 시 열 노트). 보통 활성 노트와 같지만,
// 묶음(노트 번들) 안에서 임베디드 음악 노트를 재생하면 활성 노트는 음악 노트,
// origin 은 묶음 호스트 노트가 된다 — 사용자는 "재생을 누른 화면(묶음)"으로 돌아가길 원함.
let originNoteGuid = $state<string | null>(null);
let seekToken = $state(0);
let pendingSeekTime = $state(0);
let repeat = $state<RepeatMode>('off');
let shuffle = $state(false);
// shuffle 시 재생 순서(큐 인덱스의 순열). shuffle off 면 무시.
let shuffleOrder = $state<number[]>([]);
// 노트 전환 복원: setQueue 가 저장된 위치를 여기에 담고, resume() 가 소비해 resumeAt 으로 승격.
let pendingRestore = $state(0);
// 엔진(musicAudio)이 새 src 로드 후 이 위치로 seek 한다(이어듣기). 적용 후 0.
let resumeAt = $state(0);

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
	originNoteGuid = null;
	seekToken = 0;
	pendingSeekTime = 0;
	repeat = 'off';
	shuffle = false;
	shuffleOrder = [];
	pendingRestore = 0;
	resumeAt = 0;
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
	/** 재생을 시작한 노트 guid — 레일 곡 제목 클릭 시 열 대상. 묶음 안에서 재생하면
	 *  활성(음악) 노트가 아니라 묶음 호스트 노트를 가리킨다. */
	get originNoteGuid(): string | null {
		return originNoteGuid;
	},
	/** 반복 모드: off → 끝나면 정지, all → 큐 끝에서 처음으로, one → 한 곡 무한. */
	get repeat(): RepeatMode {
		return repeat;
	},
	/** 랜덤 섞기 on/off. */
	get shuffle(): boolean {
		return shuffle;
	},
	/** 엔진이 새 src 로드 후 seek 할 이어듣기 위치(0 이면 없음). */
	get resumeAt(): number {
		return resumeAt;
	},

	/** doc 재파싱/노트 활성화 반영. 같은 노트면 재생 중 url 로 index 보존; 다른 노트로
	 *  전환하면 나가는 노트 위치를 저장하고 들어오는 노트의 저장 위치를 복원한다(이어듣기). */
	setQueue(noteGuid: string, tracks: MusicTrack[], noteName = '', originGuid?: string): void {
		const sameNote = noteGuid === activeNoteGuid;
		// origin: 명시값이 있으면 항상 우선(묶음 호스트). 없을 땐 노트가 *바뀔 때만*
		// 그 노트로 갱신 — 같은 노트 재동기화(편집)는 기존 origin 을 보존한다.
		if (originGuid) originNoteGuid = originGuid;
		else if (!sameNote) originNoteGuid = noteGuid;
		// 전환이면 나가는 노트의 현재 위치를 저장.
		if (!sameNote && activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, currentTime);
		}
		const prevUrl = sameNote ? (queue[currentIndex]?.url ?? null) : null;
		queue = tracks;
		activeNoteGuid = noteGuid;
		activeNoteName = noteName;
		if (sameNote) {
			let idx = prevUrl ? tracks.findIndex((t) => t.url === prevUrl) : -1;
			if (idx === -1) {
				idx = tracks.length ? 0 : -1;
				isPlaying = false;
				currentTime = 0;
				duration = 0;
			}
			currentIndex = idx;
		} else {
			// 들어오는 노트의 저장 위치 복원(트랙 url 로 식별, 없으면 0번/0초).
			const entry = loadProgress(noteGuid);
			let idx = entry ? tracks.findIndex((t) => t.url === entry.trackUrl) : -1;
			if (idx === -1) idx = tracks.length ? 0 : -1;
			currentIndex = idx;
			isPlaying = false;
			currentTime = 0;
			duration = 0;
			pendingRestore = entry && idx >= 0 ? entry.currentTime : 0;
		}
		if (shuffle) rebuildShuffle(true);
	},

	/** 현재(복원된) 활성 노트를 그 위치에서 이어 재생. pendingRestore 를 resumeAt 으로 승격. */
	resume(): void {
		if (queue.length === 0) return;
		if (currentIndex < 0) currentIndex = 0;
		isPlaying = true;
		if (pendingRestore > 0) {
			resumeAt = pendingRestore;
			currentTime = pendingRestore;
		}
		pendingRestore = 0;
	},

	/** 노트를 활성화하고 저장된 위치에서 이어 재생(다른 노트는 정지). 메인 ▶ 진입점.
	 *  originGuid: 재생을 시작한 노트(묶음 호스트). 없으면 noteGuid 가 곧 origin. */
	playNote(noteGuid: string, tracks: MusicTrack[], noteName = '', originGuid?: string): void {
		this.setQueue(noteGuid, tracks, noteName, originGuid);
		this.resume();
	},

	/** 엔진이 resumeAt 을 적용하고 비운다(1회성). */
	takeResumeAt(): number {
		const v = resumeAt;
		resumeAt = 0;
		return v;
	},

	/** 정지 + 활성 해제(알약 ✕). 오디오를 멈추고 큐/활성노트를 비우되, 마지막 위치는
	 *  저장해 두어 다음에 그 노트에서 이어 재생할 수 있게 한다. */
	stop(): void {
		if (activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, currentTime);
			flushProgress();
		}
		isPlaying = false;
		queue = [];
		currentIndex = -1;
		currentTime = 0;
		duration = 0;
		activeNoteGuid = null;
		activeNoteName = '';
		originNoteGuid = null;
		pendingRestore = 0;
		resumeAt = 0;
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
		pendingRestore = 0;
		resumeAt = 0;
		const i = clampIndex(index);
		if (i !== currentIndex) {
			currentIndex = i;
			currentTime = 0;
		}
		isPlaying = true;
	},

	pause(): void {
		isPlaying = false;
		if (activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, currentTime);
			flushProgress();
		}
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
		if (activeNoteGuid && queue[currentIndex]) {
			saveProgress(activeNoteGuid, queue[currentIndex].url, t);
		}
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
	},

	/** localStorage 복원용 세션 스냅샷 적용(currentTime 제외 — musicProgress 담당). 자동재생 안 함. */
	restoreSession(snap: {
		activeNoteGuid: string;
		activeNoteName: string;
		queue: MusicTrack[];
		currentIndex: number;
		originNoteGuid?: string;
	}): void {
		if (!snap || !Array.isArray(snap.queue) || snap.queue.length === 0) return;
		queue = snap.queue;
		activeNoteGuid = snap.activeNoteGuid;
		activeNoteName = snap.activeNoteName ?? '';
		originNoteGuid = snap.originNoteGuid ?? snap.activeNoteGuid;
		currentIndex = clampIndex(snap.currentIndex);
		isPlaying = false;
		currentTime = 0;
		duration = 0;
		const entry = currentIndex >= 0 ? loadProgress(snap.activeNoteGuid) : null;
		pendingRestore = entry && entry.trackUrl === queue[currentIndex]?.url ? entry.currentTime : 0;
		if (shuffle) rebuildShuffle(true);
	},

	/** 레일 재생 버튼 진입점. 재생 중이면 일시정지; 아니면 이어재생하되 큐가 소진됐으면 처음부터. */
	resumeOrRestart(): void {
		if (queue.length === 0) return;
		if (isPlaying) {
			this.pause();
			return;
		}
		const ord = playOrder();
		const lastIdx = ord[ord.length - 1];
		const exhausted =
			currentIndex < 0 ||
			(currentIndex === lastIdx && duration > 0 && currentTime >= duration - 0.5);
		if (exhausted) {
			const first = ord[0];
			if (first === currentIndex) {
				this.requestSeek(0);
				isPlaying = true;
			} else {
				this.play(first);
			}
		} else {
			this.resume();
		}
	}
};
