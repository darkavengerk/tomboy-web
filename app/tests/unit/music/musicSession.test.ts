import { describe, it, expect, beforeEach } from 'vitest';
import {
	saveSession,
	loadSession,
	__clearMusicSessionStorage
} from '$lib/music/musicSession.svelte.js';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

const t = (url: string): MusicTrack => ({ url, title: null, display: url, liPos: 0 });

beforeEach(() => __clearMusicSessionStorage());

describe('musicSession', () => {
	it('save 후 load 가 같은 스냅샷을 돌려준다', () => {
		const snap = {
			activeNoteGuid: 'n1',
			activeNoteName: '노트',
			queue: [t('a'), t('b')],
			currentIndex: 1
		};
		saveSession(snap);
		expect(loadSession()).toEqual(snap);
	});

	it('저장 없으면 null', () => {
		expect(loadSession()).toBeNull();
	});

	it('빈 큐로 저장하면 키가 지워진다', () => {
		saveSession({ activeNoteGuid: 'n1', activeNoteName: '', queue: [t('a')], currentIndex: 0 });
		saveSession({ activeNoteGuid: 'n1', activeNoteName: '', queue: [], currentIndex: 0 });
		expect(loadSession()).toBeNull();
	});

	it('손상 페이로드면 null', () => {
		window.localStorage.setItem('tomboy.musicSession', '{not json');
		expect(loadSession()).toBeNull();
	});
});
