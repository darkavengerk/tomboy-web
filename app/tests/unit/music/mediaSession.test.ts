import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	isMediaSessionSupported,
	buildMetadataInit,
	installMediaSession,
	syncMediaSession,
	__resetMediaSession
} from '$lib/music/mediaSession.js';

interface FakeSession {
	metadata: { title: string; artist: string; album: string } | null;
	playbackState: string;
	handlers: Record<string, ((d?: unknown) => void) | null>;
	positionStates: Array<{ duration: number; position: number; playbackRate: number }>;
	setActionHandler(a: string, h: ((d?: unknown) => void) | null): void;
	setPositionState(s: { duration: number; position: number; playbackRate: number }): void;
}

let session: FakeSession;
let metaCtorCount = 0;

function makeSession(): FakeSession {
	return {
		metadata: null,
		playbackState: 'none',
		handlers: {},
		positionStates: [],
		setActionHandler(a, h) {
			this.handlers[a] = h;
		},
		setPositionState(s) {
			this.positionStates.push(s);
		}
	};
}

beforeEach(() => {
	session = makeSession();
	metaCtorCount = 0;
	Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
	(globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = class {
		title: string;
		artist: string;
		album: string;
		artwork: unknown;
		constructor(init: { title?: string; artist?: string; album?: string; artwork?: unknown }) {
			this.title = init.title ?? '';
			this.artist = init.artist ?? '';
			this.album = init.album ?? '';
			this.artwork = init.artwork ?? [];
			metaCtorCount++;
		}
	};
	__resetMediaSession();
});

afterEach(() => {
	delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
	delete (globalThis as unknown as { MediaMetadata?: unknown }).MediaMetadata;
	__resetMediaSession();
});

const meta = (trackDisplay: string, playlistLabel = '', noteName = 'n') =>
	buildMetadataInit({ trackDisplay, playlistLabel, noteName });

describe('mediaSession.buildMetadataInit', () => {
	it('maps track/playlist/note to title/artist/album/artwork', () => {
		const init = buildMetadataInit({ trackDisplay: 'a', playlistLabel: '길', noteName: '드라이브' });
		expect(init.title).toBe('a');
		expect(init.artist).toBe('길');
		expect(init.album).toBe('드라이브');
		expect(Array.isArray(init.artwork)).toBe(true);
		expect(init.artwork?.[0]?.src).toBe('/icons/icon-192.png');
	});
});

describe('mediaSession.syncMediaSession', () => {
	it('sets playbackState from isPlaying', () => {
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 100, position: 5 });
		expect(session.playbackState).toBe('playing');
		syncMediaSession({ metaInit: meta('a'), isPlaying: false, duration: 100, position: 5 });
		expect(session.playbackState).toBe('paused');
	});

	it('sets playbackState none when there is no track', () => {
		syncMediaSession({ metaInit: null, isPlaying: false, duration: 0, position: 0 });
		expect(session.playbackState).toBe('none');
	});

	it('rebuilds metadata only when the meta key changes', () => {
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 100, position: 1 });
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 100, position: 2 });
		expect(metaCtorCount).toBe(1); // position change → no rebuild
		syncMediaSession({ metaInit: meta('b'), isPlaying: true, duration: 100, position: 0 });
		expect(metaCtorCount).toBe(2); // new track → rebuild
	});

	it('skips setPositionState when duration <= 0', () => {
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 0, position: 0 });
		expect(session.positionStates.length).toBe(0);
	});

	it('clamps position into [0, duration]', () => {
		syncMediaSession({ metaInit: meta('a'), isPlaying: true, duration: 100, position: 250 });
		expect(session.positionStates.at(-1)).toEqual({ duration: 100, position: 100, playbackRate: 1 });
	});
});

describe('mediaSession.installMediaSession', () => {
	it('wires handlers to callbacks and uninstall clears them', () => {
		const calls: string[] = [];
		const uninstall = installMediaSession({
			play: () => calls.push('play'),
			pause: () => calls.push('pause'),
			next: () => calls.push('next'),
			prev: () => calls.push('prev'),
			seekTo: (t) => calls.push('seek:' + t)
		});
		session.handlers['play']?.();
		session.handlers['pause']?.();
		session.handlers['nexttrack']?.();
		session.handlers['previoustrack']?.();
		session.handlers['seekto']?.({ seekTime: 12 });
		expect(calls).toEqual(['play', 'pause', 'next', 'prev', 'seek:12']);
		uninstall();
		expect(session.handlers['play']).toBeNull();
		expect(session.handlers['seekto']).toBeNull();
	});
});

describe('mediaSession — unsupported environment', () => {
	it('is a no-op when navigator.mediaSession is absent', () => {
		delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
		expect(isMediaSessionSupported()).toBe(false);
		expect(() =>
			syncMediaSession({ metaInit: null, isPlaying: false, duration: 0, position: 0 })
		).not.toThrow();
		const uninstall = installMediaSession({
			play() {},
			pause() {},
			next() {},
			prev() {},
			seekTo() {}
		});
		expect(() => uninstall()).not.toThrow();
	});
});
