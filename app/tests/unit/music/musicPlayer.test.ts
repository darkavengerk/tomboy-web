import { describe, it, expect, beforeEach } from 'vitest';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

const t = (url: string): MusicTrack => ({ url, title: null, display: url, liPos: 0 });

beforeEach(() => {
	__resetMusicPlayer();
	__resetMusicProgress();
});

describe('musicPlayer.setQueue', () => {
	it('starts at index 0 paused for a fresh note', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
	it('preserves the playing track by url across re-parse (same note)', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b'), t('c')]);
		musicPlayer.play(2); // c
		musicPlayer.setQueue('n1', [t('x'), t('a'), t('b'), t('c')]); // c moved to idx 3
		expect(musicPlayer.currentTrack?.url).toBe('c');
		expect(musicPlayer.currentIndex).toBe(3);
		expect(musicPlayer.isPlaying).toBe(true);
	});
	it('resets to 0 paused when the playing url vanished', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.setQueue('n1', [t('a'), t('z')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
	it('resets on a different note even if a url coincides', () => {
		musicPlayer.setQueue('n1', [t('a')]);
		musicPlayer.play(0);
		musicPlayer.setQueue('n2', [t('a'), t('b')]);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(false);
	});
});

describe('musicPlayer transport', () => {
	it('toggle from no selection plays first', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.toggle();
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.currentIndex).toBe(0);
	});
	it('next stops at end of queue', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.next();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.currentIndex).toBe(1);
	});
	it('reportEnded advances to next track', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(0);
		musicPlayer.reportEnded();
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.isPlaying).toBe(true);
	});
	it('prev at start requests seek to 0', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(0);
		const before = musicPlayer.seekToken;
		musicPlayer.prev();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.seekToken).toBe(before + 1);
	});
	it('requestSeek bumps token and updates time', () => {
		musicPlayer.setQueue('n1', [t('a')]);
		const before = musicPlayer.seekToken;
		musicPlayer.requestSeek(42);
		expect(musicPlayer.currentTime).toBe(42);
		expect(musicPlayer.seekToken).toBe(before + 1);
	});
	it('pause stops playback without changing the index', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		expect(musicPlayer.isPlaying).toBe(true);
		musicPlayer.pause();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.currentIndex).toBe(1);
	});
});

describe('musicPlayer 반복(repeat)', () => {
	it('cycleRepeat 가 off → all → one → off 로 순환', () => {
		expect(musicPlayer.repeat).toBe('off');
		musicPlayer.cycleRepeat();
		expect(musicPlayer.repeat).toBe('all');
		musicPlayer.cycleRepeat();
		expect(musicPlayer.repeat).toBe('one');
		musicPlayer.cycleRepeat();
		expect(musicPlayer.repeat).toBe('off');
	});

	it('repeat=all: 마지막 곡이 끝나면 처음으로 감싸 재생', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.cycleRepeat(); // all
		musicPlayer.play(1);
		musicPlayer.reportEnded();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('repeat=all: 사용자 next 도 끝에서 처음으로 감싼다', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.cycleRepeat(); // all
		musicPlayer.play(1);
		musicPlayer.next();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('repeat=one: 곡이 끝나면 같은 곡을 처음부터(인덱스 유지 + seek 0)', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.cycleRepeat();
		musicPlayer.cycleRepeat(); // one
		musicPlayer.play(0);
		musicPlayer.reportTime(30);
		const before = musicPlayer.seekToken;
		musicPlayer.reportEnded();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.seekToken).toBe(before + 1);
		expect(musicPlayer.currentTime).toBe(0);
	});

	it('repeat=one: 사용자 next 는 한 곡 가둠을 무시하고 다음 곡으로', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.cycleRepeat();
		musicPlayer.cycleRepeat(); // one
		musicPlayer.play(0);
		musicPlayer.next();
		expect(musicPlayer.currentIndex).toBe(1);
	});

	it('repeat=all + 한 곡 큐: 끝나면 같은 곡 처음부터', () => {
		musicPlayer.setQueue('n1', [t('a')]);
		musicPlayer.cycleRepeat(); // all
		musicPlayer.play(0);
		musicPlayer.reportTime(10);
		const before = musicPlayer.seekToken;
		musicPlayer.reportEnded();
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.isPlaying).toBe(true);
		expect(musicPlayer.seekToken).toBe(before + 1);
	});

	it('repeat=off: 마지막 곡이 끝나면 정지(기존 동작 유지)', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.reportEnded();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.currentIndex).toBe(1);
	});
});

describe('musicPlayer 랜덤 섞기(shuffle)', () => {
	it('toggleShuffle 가 상태를 토글', () => {
		expect(musicPlayer.shuffle).toBe(false);
		musicPlayer.toggleShuffle();
		expect(musicPlayer.shuffle).toBe(true);
		musicPlayer.toggleShuffle();
		expect(musicPlayer.shuffle).toBe(false);
	});

	it('shuffle on: 켜는 순간 현재 곡은 그대로(튀지 않음)', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b'), t('c'), t('d')]);
		musicPlayer.play(2); // c
		musicPlayer.toggleShuffle();
		expect(musicPlayer.currentTrack?.url).toBe('c');
	});

	it('shuffle on: next 를 큐 길이만큼 돌면 모든 곡을 정확히 한 번씩 방문(순열)', () => {
		const urls = ['a', 'b', 'c', 'd', 'e'];
		musicPlayer.setQueue('n1', urls.map(t));
		musicPlayer.play(0);
		musicPlayer.toggleShuffle();
		const visited = [musicPlayer.currentTrack!.url];
		for (let i = 0; i < urls.length - 1; i++) {
			musicPlayer.next();
			visited.push(musicPlayer.currentTrack!.url);
		}
		expect([...visited].sort()).toEqual([...urls].sort()); // 전부 한 번씩
		expect(new Set(visited).size).toBe(urls.length); // 중복 없음
	});

	it('shuffle + repeat=off: 섞인 순서 끝에서 next 는 정지', () => {
		musicPlayer.setQueue('n1', [t('a'), t('b'), t('c')]);
		musicPlayer.play(0);
		musicPlayer.toggleShuffle();
		musicPlayer.next();
		musicPlayer.next(); // 마지막
		expect(musicPlayer.isPlaying).toBe(true);
		musicPlayer.next(); // 끝 넘어감
		expect(musicPlayer.isPlaying).toBe(false);
	});
});

describe('musicPlayer 노트별 이어듣기', () => {
	it('다른 노트로 갔다 돌아오면 트랙+위치를 복원해 이어 재생', () => {
		musicPlayer.playNote('A', [t('a'), t('b')]);
		musicPlayer.play(1); // 트랙 b
		musicPlayer.reportTime(33);
		musicPlayer.playNote('B', [t('c')]); // B 로 전환(A@b:33 저장)
		expect(musicPlayer.activeNoteGuid).toBe('B');
		musicPlayer.playNote('A', [t('a'), t('b')]); // A 로 복귀
		expect(musicPlayer.currentIndex).toBe(1);
		expect(musicPlayer.currentTrack?.url).toBe('b');
		expect(musicPlayer.currentTime).toBeCloseTo(33, 0);
		expect(musicPlayer.resumeAt).toBeCloseTo(33, 0);
		expect(musicPlayer.isPlaying).toBe(true);
	});

	it('stop: 정지+활성 해제, 진행위치는 보존', () => {
		musicPlayer.playNote('A', [t('a')]);
		musicPlayer.reportTime(12);
		musicPlayer.stop();
		expect(musicPlayer.isPlaying).toBe(false);
		expect(musicPlayer.activeNoteGuid).toBeNull();
		expect(musicPlayer.queue.length).toBe(0);
		musicPlayer.playNote('A', [t('a')]);
		expect(musicPlayer.currentTime).toBeCloseTo(12, 0);
	});

	it('명시적 play(index) 는 복원을 버리고 그 트랙을 0:00 부터', () => {
		musicPlayer.playNote('A', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.reportTime(20);
		musicPlayer.playNote('B', [t('c')]);
		musicPlayer.setQueue('A', [t('a'), t('b')]);
		musicPlayer.play(0);
		expect(musicPlayer.currentIndex).toBe(0);
		expect(musicPlayer.currentTime).toBe(0);
		expect(musicPlayer.resumeAt).toBe(0);
	});

	it('resume 후 play(index) 는 resumeAt 도 비운다(다른 트랙에 stale seek 방지)', () => {
		// A 에 저장 위치를 만들고
		musicPlayer.playNote('A', [t('a'), t('b')]);
		musicPlayer.play(1);
		musicPlayer.reportTime(40);
		musicPlayer.playNote('B', [t('c')]);
		// A 로 복귀 → resume 이 resumeAt 을 40 으로 승격
		musicPlayer.playNote('A', [t('a'), t('b')]);
		expect(musicPlayer.resumeAt).toBeCloseTo(40, 0);
		// 엔진이 소비하기 전에 사용자가 트랙 0 을 명시적으로 클릭하면 resumeAt 이 비워져야 한다
		musicPlayer.play(0);
		expect(musicPlayer.resumeAt).toBe(0);
		expect(musicPlayer.currentTime).toBe(0);
	});
});
