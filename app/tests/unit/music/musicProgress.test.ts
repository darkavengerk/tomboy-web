import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadProgress,
	saveProgress,
	clearProgress,
	flushProgress,
	__resetMusicProgress
} from '$lib/music/musicProgress.js';

beforeEach(() => __resetMusicProgress());

describe('musicProgress', () => {
	it('save 직후 load 가 동기로 같은 값을 돌려준다', () => {
		saveProgress('A', 'https://h/a.mp3', 42);
		expect(loadProgress('A')).toEqual({ trackUrl: 'https://h/a.mp3', currentTime: 42 });
	});

	it('저장 없으면 null', () => {
		expect(loadProgress('none')).toBeNull();
	});

	it('같은 guid 재저장은 덮어쓴다', () => {
		saveProgress('A', 'https://h/a.mp3', 10);
		saveProgress('A', 'https://h/b.mp3', 5);
		expect(loadProgress('A')).toEqual({ trackUrl: 'https://h/b.mp3', currentTime: 5 });
	});

	it('clearProgress 는 해당 guid 만 지운다', () => {
		saveProgress('A', 'https://h/a.mp3', 1);
		saveProgress('B', 'https://h/b.mp3', 2);
		clearProgress('A');
		expect(loadProgress('A')).toBeNull();
		expect(loadProgress('B')).toEqual({ trackUrl: 'https://h/b.mp3', currentTime: 2 });
	});

	it('flush 후 인메모리 맵을 비워도 localStorage 에서 복원된다', () => {
		saveProgress('A', 'https://h/a.mp3', 7);
		flushProgress();
		const raw = window.localStorage.getItem('tomboy.musicProgress');
		expect(raw).toBeTruthy();
		const parsed = JSON.parse(raw!);
		expect(parsed.A).toMatchObject({ trackUrl: 'https://h/a.mp3', currentTime: 7 });
	});

	it('손상 JSON 이어도 throw 없이 빈 맵', () => {
		window.localStorage.setItem('tomboy.musicProgress', '{not json');
		__resetMusicProgress();
		window.localStorage.setItem('tomboy.musicProgress', '{not json');
		saveProgress('A', 'https://h/a.mp3', 3);
		expect(loadProgress('A')).toEqual({ trackUrl: 'https://h/a.mp3', currentTime: 3 });
	});
});
